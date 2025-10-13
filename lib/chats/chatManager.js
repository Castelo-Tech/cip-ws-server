import { EventEmitter } from 'events';
import wwebjs from 'whatsapp-web.js';
import { MediaConverter } from '../utils/mediaConverter.js';

const { MessageMedia } = wwebjs;

export class ChatManager extends EventEmitter {
  constructor(sessionManager) {
    super();
    this.sessionManager = sessionManager;
  }

  keyOf(accountId, label) {
    return `${accountId}::${label}`;
  }

  async getChats(accountId, label) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    if (!client) throw new Error('Session not found');

    try {
      const chats = await client.getChats();
      return chats.map(chat => ({
        id: chat.id._serialized,
        name: chat.name,
        isGroup: chat.isGroup,
        isReadOnly: chat.isReadOnly,
        unreadCount: chat.unreadCount,
        timestamp: chat.timestamp,
        lastMessage: chat.lastMessage ? {
          id: chat.lastMessage.id._serialized,
          body: chat.lastMessage.body,
          type: chat.lastMessage.type,
          fromMe: chat.lastMessage.fromMe,
          timestamp: chat.lastMessage.timestamp,
          hasMedia: chat.lastMessage.hasMedia
        } : null
      }));
    } catch (error) {
      throw new Error(`Failed to get chats: ${error.message}`);
    }
  }

  async getChatById(accountId, label, chatId) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    if (!client) throw new Error('Session not found');

    try {
      const chat = await client.getChatById(chatId);
      return this.formatChat(chat);
    } catch (error) {
      throw new Error(`Failed to get chat: ${error.message}`);
    }
  }

  async getMessages(accountId, label, chatId, limit = 50) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    if (!client) throw new Error('Session not found');

    try {
      const chat = await client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit });
      return messages.map(message => this.formatMessage(message));
    } catch (error) {
      throw new Error(`Failed to get messages: ${error.message}`);
    }
  }

  async sendMessage(accountId, label, chatId, content) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    if (!client) throw new Error('Session not found');

    try {
      const chat = await client.getChatById(chatId);
      const message = await chat.sendMessage(content);
      return this.formatMessage(message);
    } catch (error) {
      throw new Error(`Failed to send message: ${error.message}`);
    }
  }

  async sendMedia(accountId, label, chatId, mediaData) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    if (!client) throw new Error('Session not found');

    try {
      let finalMediaData = mediaData;
      if (mediaData.mimetype.startsWith('image/') && !mediaData.mimetype.includes('jpeg')) {
        finalMediaData = await MediaConverter.ensureWhatsAppImageFormat(mediaData.data, mediaData.mimetype);
      }

      const media = new MessageMedia(finalMediaData.mimetype, finalMediaData.data, finalMediaData.filename);
      const chat = await client.getChatById(chatId);
      const options = mediaData.caption ? { caption: mediaData.caption } : {};
      const message = await chat.sendMessage(media, options);
      return this.formatMessage(message);
    } catch (error) {
      console.error('Media send error:', error);
      throw new Error(`Failed to send media: ${error.message}`);
    }
  }

  async sendVoiceNote(accountId, label, chatId, audioData, originalMime = 'audio/webm') {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    if (!client) throw new Error('Session not found');

    try {
      const convertedAudio = await MediaConverter.convertAudioToWhatsAppFormat(audioData, originalMime);
      const audio = new MessageMedia(convertedAudio.mimetype, convertedAudio.data, convertedAudio.filename);
      const chat = await client.getChatById(chatId);
      const message = await chat.sendMessage(audio, { sendAudioAsVoice: true });
      return this.formatMessage(message);
    } catch (error) {
      console.error('Voice note send error details:', { accountId, label, chatId, error: error.message });
      throw new Error(`Failed to send voice note: ${error.message}`);
    }
  }

  async downloadMedia(accountId, label, messageId) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    if (!client) throw new Error('Session not found');

    try {
      // Direct fetch by ID first
      try {
        const message = await client.getMessageById(messageId);
        if (message) return await this.downloadMessageMedia(message, messageId);
      } catch (directError) {
        // Fall through to search
      }

      const parts = messageId.split('_');
      const chatId = parts.length >= 2 ? parts[1] : null;

      if (chatId) {
        try {
          const chat = await client.getChatById(chatId);
          const windows = [120, 300, 600, 1200];
          for (const limit of windows) {
            const msgs = await chat.fetchMessages({ limit });
            const found = msgs.find(m => m.id._serialized === messageId);
            if (found) return await this.downloadMessageMedia(found, messageId);
          }
        } catch { /* ignore */ }
      }

      const chats = await client.getChats();
      for (const chat of chats) {
        try {
          const messages = await chat.fetchMessages({ limit: 50 });
          const foundMessage = messages.find(msg => msg.id._serialized === messageId);
          if (foundMessage) return await this.downloadMessageMedia(foundMessage, messageId);
        } catch { continue; }
      }

      throw new Error(`Message with ID ${messageId} not found in recent messages`);
    } catch (error) {
      console.error('Media download error:', error);
      throw new Error(`Failed to download media: ${error.message}`);
    }
  }

  async downloadMessageMedia(message, messageId) {
    if (!message.hasMedia) throw new Error('Message does not contain media');
    const maxAttempts = 5;
    const baseDelayMs = 400;

    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const media = await message.downloadMedia();
        if (media && media.data) {
          return {
            success: true,
            data: media.data,
            mimetype: media.mimetype,
            filename: message.body || `media_${messageId}.${this.getFileExtension(media.mimetype)}`,
            messageId
          };
        }
        lastErr = new Error('Failed to download media - no media data returned');
      } catch (e) {
        lastErr = e;
      }
      const wait = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 150);
      await new Promise(r => setTimeout(r, wait));
    }

    throw (lastErr || new Error('Failed to download media'));
  }

  getFileExtension(mimetype) {
    const extensions = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/3gpp': '3gp',
      'audio/ogg': 'ogg',
      'audio/ogg; codecs=opus': 'opus',
      'audio/aac': 'aac',
      'application/pdf': 'pdf',
      'application/octet-stream': 'bin'
    };
    return extensions[mimetype] || 'bin';
  }

  formatChat(chat) {
    return {
      id: chat.id._serialized,
      name: chat.name,
      isGroup: chat.isGroup,
      isReadOnly: chat.isReadOnly,
      unreadCount: chat.unreadCount,
      timestamp: chat.timestamp,
      lastMessage: chat.lastMessage ? this.formatMessage(chat.lastMessage) : null
    };
  }

  formatMessage(message) {
    return {
      id: message.id._serialized,
      body: message.body,
      type: message.type,
      from: message.from,
      to: message.to,
      fromMe: message.fromMe,
      author: message.author,
      timestamp: message.timestamp,
      hasMedia: message.hasMedia,
      mediaKey: message.mediaKey,
      location: message.location,
    };
  }
}

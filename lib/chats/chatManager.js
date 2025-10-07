import { EventEmitter } from 'events';
import wwebjs from 'whatsapp-web.js';
import { MediaConverter } from '../utils/mediaConverter.js';

const { MessageMedia } = wwebjs;

export class ChatManager extends EventEmitter {
  constructor(sessionManager) {
    super();
    this.sessionManager = sessionManager;
    this.chats = new Map(); // key -> { chats: [], contacts: [] }
  }

  keyOf(accountId, label) {
    return `${accountId}::${label}`;
  }

  async getChats(accountId, label) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    
    if (!client) {
      throw new Error('Session not found');
    }

    try {
      const chats = await client.getChats();
      const formattedChats = chats.map(chat => ({
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

      // Store in cache
      this.chats.set(key, { 
        chats: formattedChats,
        contacts: await this.getContacts(client)
      });

      return formattedChats;
    } catch (error) {
      throw new Error(`Failed to get chats: ${error.message}`);
    }
  }

  async getContacts(client) {
    try {
      const contacts = await client.getContacts();
      return contacts.map(contact => ({
        id: contact.id._serialized,
        name: contact.name,
        number: contact.id.user,
        isBusiness: contact.isBusiness,
        isMyContact: contact.isMyContact
      }));
    } catch (error) {
      return [];
    }
  }

  async getChatById(accountId, label, chatId) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    
    if (!client) {
      throw new Error('Session not found');
    }

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
    
    if (!client) {
      throw new Error('Session not found');
    }

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
    
    if (!client) {
      throw new Error('Session not found');
    }

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
    
    if (!client) {
      throw new Error('Session not found');
    }

    try {
      let finalMediaData = mediaData;
      
      // Convert images to JPEG for better WhatsApp compatibility
      if (mediaData.mimetype.startsWith('image/') && !mediaData.mimetype.includes('jpeg')) {
        finalMediaData = await MediaConverter.ensureWhatsAppImageFormat(mediaData.data, mediaData.mimetype);
      }
      
      const media = new MessageMedia(
        finalMediaData.mimetype, 
        finalMediaData.data,
        finalMediaData.filename
      );
      
      const chat = await client.getChatById(chatId);
      const options = mediaData.caption ? { caption: mediaData.caption } : {};
      const message = await chat.sendMessage(media, options);
      
      return this.formatMessage(message);
    } catch (error) {
      console.error('Media send error:', error);
      throw new Error(`Failed to send media: ${error.message}`);
    }
  }

  async sendVoiceNote(accountId, label, chatId, audioData) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    
    if (!client) {
      throw new Error('Session not found');
    }

    try {
      console.log(`Starting voice note conversion for ${accountId}::${label}, data size: ${audioData.length} chars`);
      
      // Convert to WhatsApp-compatible OGG/Opus format
      const convertedAudio = await MediaConverter.convertAudioToWhatsAppFormat(audioData, 'audio/webm');
      
      console.log(`Voice note converted successfully, size: ${convertedAudio.data.length} chars`);
      
      const audio = new MessageMedia(
        convertedAudio.mimetype, 
        convertedAudio.data, 
        convertedAudio.filename
      );
      
      const chat = await client.getChatById(chatId);
      console.log(`Sending voice note to chat: ${chatId}`);
      
      const message = await chat.sendMessage(audio, {
        sendAudioAsVoice: true
      });
      
      console.log(`Voice note sent successfully, message ID: ${message.id._serialized}`);
      return this.formatMessage(message);
    } catch (error) {
      console.error('Voice note send error details:', {
        accountId,
        label,
        chatId,
        error: error.message
      });
      throw new Error(`Failed to send voice note: ${error.message}`);
    }
  }

  // FIXED: Much faster and more reliable media download
  async downloadMedia(accountId, label, messageId) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    
    if (!client) {
      throw new Error('Session not found');
    }

    try {
      console.log(`Searching for message: ${messageId}`);
      
      // Try to get the message directly first (much faster)
      try {
        const message = await client.getMessageById(messageId);
        if (message) {
          console.log(`Found message directly: ${messageId}`);
          return await this.downloadMessageMedia(message, messageId);
        }
      } catch (directError) {
        console.log(`Direct message fetch failed, falling back to chat search: ${directError.message}`);
      }

      // Fallback: search through recent chats
      const chats = await client.getChats();
      console.log(`Searching ${chats.length} chats for message ${messageId}`);
      
      for (const chat of chats) {
        try {
          // Only fetch a small number of recent messages per chat
          const messages = await chat.fetchMessages({ limit: 50 });
          const foundMessage = messages.find(msg => msg.id._serialized === messageId);
          
          if (foundMessage) {
            console.log(`Found message in chat: ${chat.name}`);
            return await this.downloadMessageMedia(foundMessage, messageId);
          }
        } catch (chatError) {
          console.warn(`Error searching chat ${chat.id._serialized}:`, chatError.message);
          continue;
        }
      }

      throw new Error(`Message with ID ${messageId} not found in recent messages`);
    } catch (error) {
      console.error('Media download error:', error);
      throw new Error(`Failed to download media: ${error.message}`);
    }
  }

  // Helper method to download media from a found message
  async downloadMessageMedia(message, messageId) {
    if (!message.hasMedia) {
      throw new Error('Message does not contain media');
    }

    console.log(`Downloading media for message: ${messageId}`);
    const media = await message.downloadMedia();
    
    if (!media) {
      throw new Error('Failed to download media - no media data returned');
    }

    if (!media.data) {
      throw new Error('Failed to download media - empty media data');
    }

    console.log(`Media downloaded successfully, size: ${media.data.length} chars, type: ${media.mimetype}`);
    
    return {
      success: true,
      data: media.data,
      mimetype: media.mimetype,
      filename: message.body || `media_${messageId}.${this.getFileExtension(media.mimetype)}`,
      messageId: messageId
    };
  }

  // Helper method to get file extension from mimetype
  getFileExtension(mimetype) {
    const extensions = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/3gpp': '3gp',
      'audio/ogg': 'ogg',
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
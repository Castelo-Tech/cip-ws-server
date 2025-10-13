import { Router } from 'express';
import multer from 'multer';
import { ensureMediaCacheDir, memGet, memSet, diskLoad, diskSave } from '../lib/utils/mediaCache.js';
import { sendBufferWithRange } from '../lib/utils/httpRange.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

export function createChatRoutes(sessionManager, io) {
  const router = Router();
  const chatManager = sessionManager.getChatManager();

  // Ensure .media_cache exists
  ensureMediaCacheDir();

  router.get('/sessions/:accountId/:label/chats', async (req, res) => {
    const { accountId, label } = req.params;
    try {
      const chats = await chatManager.getChats(accountId, label);
      res.json(chats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/sessions/:accountId/:label/chats/:chatId', async (req, res) => {
    const { accountId, label, chatId } = req.params;
    try {
      const chat = await chatManager.getChatById(accountId, label, chatId);
      res.json(chat);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/sessions/:accountId/:label/chats/:chatId/messages', async (req, res) => {
    const { accountId, label, chatId } = req.params;
    const { limit = 50 } = req.query;
    try {
      const messages = await chatManager.getMessages(accountId, label, chatId, parseInt(limit));
      res.json(messages);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/sessions/:accountId/:label/chats/:chatId/messages', async (req, res) => {
    const { accountId, label, chatId } = req.params;
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Message content is required' });
    try {
      const message = await chatManager.sendMessage(accountId, label, chatId, content);
      res.json(message);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/sessions/:accountId/:label/chats/:chatId/media', upload.single('media'), async (req, res) => {
    const { accountId, label, chatId } = req.params;
    const { caption } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Media file is required' });
    try {
      const mediaData = {
        mimetype: req.file.mimetype,
        data: req.file.buffer.toString('base64'),
        filename: req.file.originalname,
        caption: caption || ''
      };
      const message = await chatManager.sendMedia(accountId, label, chatId, mediaData);
      res.json(message);
    } catch (error) {
      console.error('Media upload error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/sessions/:accountId/:label/chats/:chatId/voice', upload.single('audio'), async (req, res) => {
    const { accountId, label, chatId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'Audio file is required' });
    if (req.file.size < 3000) return res.status(400).json({ error: 'Voice note too short — please record a bit longer.' });

    try {
      const audioData = req.file.buffer.toString('base64');
      const originalMime = req.file.mimetype || 'audio/webm';
      const message = await chatManager.sendVoiceNote(accountId, label, chatId, audioData, originalMime);
      res.json(message);
    } catch (error) {
      console.error('Voice note upload error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Media streaming with memory+disk cache and HTTP range — same behavior, cleaner placement
  router.get('/sessions/:accountId/:label/media/:messageId', async (req, res) => {
    const { accountId, label, messageId } = req.params;

    try {
      let cached = memGet(messageId);

      if (!cached) {
        const disk = diskLoad(messageId);
        if (disk) {
          cached = disk;
          memSet(messageId, cached);
        }
      }

      if (!cached) {
        try {
          const media = await chatManager.downloadMedia(accountId, label, messageId);
          const buffer = Buffer.from(media.data, 'base64');
          cached = { buffer, mimetype: media.mimetype, filename: media.filename || `media_${messageId}` };
          memSet(messageId, cached);
          diskSave(messageId, buffer, cached.mimetype, cached.filename);
        } catch (e) {
          const disk = diskLoad(messageId);
          if (disk) {
            cached = disk;
            memSet(messageId, cached);
          } else {
            return res.status(410).json({ error: 'Media not available from WhatsApp (expired or not in recent history).' });
          }
        }
      }

      const { buffer, mimetype, filename } = cached;
      return sendBufferWithRange(res, buffer, mimetype, filename, req.headers.range);
    } catch (error) {
      console.error('Media download route error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

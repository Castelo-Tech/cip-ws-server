import { Router } from 'express';
import multer from 'multer';
import { ensureMediaCacheDir, memGet, memSet, diskLoad, diskSave } from '../lib/utils/mediaCache.js';
import { sendBufferWithRange } from '../lib/utils/httpRange.js';
import { assertSessionPermission, handleAuthzError } from '../lib/auth/authorize.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

export function createChatRoutes(sessionManager, io) {
  const router = Router();
  const chatManager = sessionManager.getChatManager();

  ensureMediaCacheDir();

  router.get('/sessions/:accountId/:label/chats', async (req, res) => {
    const { accountId, label } = req.params;
    try {
      await assertSessionPermission(accountId, label, req.auth.uid, 'viewMessages');
      const chats = await chatManager.getChats(accountId, label);
      res.json(chats);
    } catch (error) {
      if (error?.status) return handleAuthzError(res, error);
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/sessions/:accountId/:label/chats/:chatId', async (req, res) => {
    const { accountId, label, chatId } = req.params;
    try {
      await assertSessionPermission(accountId, label, req.auth.uid, 'viewMessages');
      const chat = await chatManager.getChatById(accountId, label, chatId);
      res.json(chat);
    } catch (error) {
      if (error?.status) return handleAuthzError(res, error);
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/sessions/:accountId/:label/chats/:chatId/messages', async (req, res) => {
    const { accountId, label, chatId } = req.params;
    const { limit = 50 } = req.query;
    try {
      await assertSessionPermission(accountId, label, req.auth.uid, 'viewMessages');
      const messages = await chatManager.getMessages(accountId, label, chatId, parseInt(limit));
      res.json(messages);
    } catch (error) {
      if (error?.status) return handleAuthzError(res, error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/sessions/:accountId/:label/chats/:chatId/messages', async (req, res) => {
    const { accountId, label, chatId } = req.params;
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Message content is required' });
    try {
      await assertSessionPermission(accountId, label, req.auth.uid, 'createMessages');
      const message = await chatManager.sendMessage(accountId, label, chatId, content);
      res.json(message);
    } catch (error) {
      if (error?.status) return handleAuthzError(res, error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/sessions/:accountId/:label/chats/:chatId/media', upload.single('media'), async (req, res) => {
    const { accountId, label, chatId } = req.params;
    const { caption } = req.body;
    if (!req.file) return res.status(400).json({ error: 'Media file is required' });
    try {
      await assertSessionPermission(accountId, label, req.auth.uid, 'createMessages');
      const mediaData = {
        mimetype: req.file.mimetype,
        data: req.file.buffer.toString('base64'),
        filename: req.file.originalname,
        caption: caption || ''
      };
      const message = await chatManager.sendMedia(accountId, label, chatId, mediaData);
      res.json(message);
    } catch (error) {
      if (error?.status) return handleAuthzError(res, error);
      console.error('Media upload error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/sessions/:accountId/:label/chats/:chatId/voice', upload.single('audio'), async (req, res) => {
    const { accountId, label, chatId } = req.params;
    if (!req.file) return res.status(400).json({ error: 'Audio file is required' });
    if (req.file.size < 3000) return res.status(400).json({ error: 'Voice note too short — please record a bit longer.' });

    try {
      await assertSessionPermission(accountId, label, req.auth.uid, 'createMessages');
      const audioData = req.file.buffer.toString('base64');
      const originalMime = req.file.mimetype || 'audio/webm';
      const message = await chatManager.sendVoiceNote(accountId, label, chatId, audioData, originalMime);
      res.json(message);
    } catch (error) {
      if (error?.status) return handleAuthzError(res, error);
      console.error('Voice note upload error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/sessions/:accountId/:label/media/:messageId', async (req, res) => {
    const { accountId, label, messageId } = req.params;

    try {
      await assertSessionPermission(accountId, label, req.auth.uid, 'viewMessages');

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
      if (error?.status) return handleAuthzError(res, error);
      console.error('Media download route error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

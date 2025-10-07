import { Router } from 'express';
import multer from 'multer';

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit for larger files
  }
});

export function createChatRoutes(sessionManager, io) {
  const router = Router();
  const chatManager = sessionManager.getChatManager();

  // Get all chats for a session
  router.get('/sessions/:accountId/:label/chats', async (req, res) => {
    const { accountId, label } = req.params;
    
    try {
      const chats = await chatManager.getChats(accountId, label);
      res.json(chats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get specific chat
  router.get('/sessions/:accountId/:label/chats/:chatId', async (req, res) => {
    const { accountId, label, chatId } = req.params;
    
    try {
      const chat = await chatManager.getChatById(accountId, label, chatId);
      res.json(chat);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get messages from a chat
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

  // Send text message
  router.post('/sessions/:accountId/:label/chats/:chatId/messages', async (req, res) => {
    const { accountId, label, chatId } = req.params;
    const { content } = req.body;
    
    if (!content) {
      return res.status(400).json({ error: 'Message content is required' });
    }
    
    try {
      const message = await chatManager.sendMessage(accountId, label, chatId, content);
      res.json(message);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Send media (image, document, etc.)
  router.post('/sessions/:accountId/:label/chats/:chatId/media', upload.single('media'), async (req, res) => {
    const { accountId, label, chatId } = req.params;
    const { caption } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'Media file is required' });
    }
    
    try {
      // Convert buffer to base64
      const mediaData = {
        mimetype: req.file.mimetype,
        data: req.file.buffer.toString('base64'), // Convert to base64
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

  // Send voice note
  router.post('/sessions/:accountId/:label/chats/:chatId/voice', upload.single('audio'), async (req, res) => {
    const { accountId, label, chatId } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ error: 'Audio file is required' });
    }

    // Guard against tiny/aborted blobs that ffmpeg cannot parse reliably
    if (req.file.size < 3000) {
      return res.status(400).json({ error: 'Voice note too short — please record a bit longer.' });
    }
    
    try {
      // Convert buffer to base64
      const audioData = req.file.buffer.toString('base64');
      // Pass the real mime to the converter/manager (keeps backward-compat with default)
      const originalMime = req.file.mimetype || 'audio/webm';
      const message = await chatManager.sendVoiceNote(accountId, label, chatId, audioData, originalMime);
      res.json(message);
    } catch (error) {
      console.error('Voice note upload error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Download media from a message - FIXED ROUTE
  router.get('/sessions/:accountId/:label/media/:messageId', async (req, res) => {
    const { accountId, label, messageId } = req.params;
    
    try {
      const media = await chatManager.downloadMedia(accountId, label, messageId);
      
      // Set appropriate headers for file download
      const filename = encodeURIComponent(media.filename);
      res.setHeader('Content-Type', media.mimetype);
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      
      // Convert base64 to buffer and send
      const buffer = Buffer.from(media.data, 'base64');
      res.send(buffer);
      
    } catch (error) {
      console.error('Media download route error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

import { Router } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

export function createChatRoutes(sessionManager, io) {
  const router = Router();
  const chatManager = sessionManager.getChatManager();

  // --- Disk cache for media (persists across process restarts) ---
  const MEDIA_DIR = join(process.cwd(), '.media_cache');
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });

  function diskPathFor(messageId) {
    // store as: .media_cache/<messageId>.<ext or bin>
    return join(MEDIA_DIR, messageId);
  }
  function loadFromDisk(messageId) {
    const base = diskPathFor(messageId);
    if (!existsSync(base)) return null;
    try {
      const meta = JSON.parse(readFileSync(base + '.json', 'utf8'));
      const data = readFileSync(base + '.bin');
      return { buffer: data, mimetype: meta.mimetype, filename: meta.filename || `media_${messageId}` };
    } catch {
      return null;
    }
  }
  function saveToDisk(messageId, buffer, mimetype, filename) {
    const base = diskPathFor(messageId);
    writeFileSync(base + '.bin', buffer);
    writeFileSync(base + '.json', JSON.stringify({ mimetype, filename }, null, 2));
  }

  // --- Simple in-memory cache (short TTL) for fast range slicing ---
  const MEMORY_CACHE = new Map();
  const TTL = 10 * 60 * 1000; // 10 minutes
  const getMem = (k) => {
    const v = MEMORY_CACHE.get(k);
    if (!v) return null;
    if (Date.now() - v.ts > TTL) { MEMORY_CACHE.delete(k); return null; }
    return v;
  };
  const setMem = (k, val) => MEMORY_CACHE.set(k, { ...val, ts: Date.now() });

  // Get all chats
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

  // Get messages
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

  // Send text
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

  // Send media
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

  // Send voice note
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

  // Download media (supports Range + disk/memory cache)
  router.get('/sessions/:accountId/:label/media/:messageId', async (req, res) => {
    const { accountId, label, messageId } = req.params;

    try {
      // 1) Memory cache?
      let cached = getMem(messageId);

      // 2) Disk cache?
      if (!cached) {
        const disk = loadFromDisk(messageId);
        if (disk) {
          cached = { buffer: disk.buffer, mimetype: disk.mimetype, filename: disk.filename };
          setMem(messageId, cached);
        }
      }

      // 3) If still missing, fetch once from WhatsApp and cache both memory+disk
      if (!cached) {
        try {
          const media = await chatManager.downloadMedia(accountId, label, messageId);
          const buffer = Buffer.from(media.data, 'base64');
          cached = { buffer, mimetype: media.mimetype, filename: media.filename || `media_${messageId}` };
          setMem(messageId, cached);
          // persist to disk for future (older messages may vanish from WA store)
          saveToDisk(messageId, buffer, cached.mimetype, cached.filename);
        } catch (e) {
          // if not found in WA (older/expired), but we DO have disk cache → serve that
          const disk = loadFromDisk(messageId);
          if (disk) {
            cached = { buffer: disk.buffer, mimetype: disk.mimetype, filename: disk.filename };
            setMem(messageId, cached);
          } else {
            // Graceful: let the client know it's gone, not a server error
            return res.status(410).json({ error: 'Media not available from WhatsApp (expired or not in recent history).' });
          }
        }
      }

      const { buffer, mimetype, filename } = cached;
      const size = buffer.length;

      res.setHeader('Content-Type', mimetype);
      res.setHeader('Accept-Ranges', 'bytes');

      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m) return res.status(416).end();
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end   = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        if (isNaN(start) || isNaN(end) || start > end || start >= size) return res.status(416).end();

        const chunk = buffer.subarray(start, end + 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', String(chunk.length));
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
        return res.end(chunk);
      }

      res.status(200);
      res.setHeader('Content-Length', String(size));
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
      res.end(buffer);
    } catch (error) {
      console.error('Media download route error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

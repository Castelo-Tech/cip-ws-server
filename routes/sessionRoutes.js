import { Router } from 'express';

export function createSessionRoutes(sessionManager, io) {
  const router = Router();

  router.get('/sessions', (req, res) => {
    res.json(sessionManager.getAllSessions());
  });

  router.get('/sessions/detected', (req, res) => {
    res.json(sessionManager.detectSessions());
  });

  router.post('/sessions/init', async (req, res) => {
    const { accountId, label } = req.body;
    if (!accountId || !label) return res.status(400).json({ error: 'accountId and label are required' });

    try {
      const result = await sessionManager.initSession(accountId, label);
      res.json({
        ...result,
        message: 'Session initialized. Connect to WebSocket to receive QR codes and status updates.',
        websocketEvents: [
          `qr:${accountId}:${label}`,
          `status:${accountId}:${label}`,
          `message:${accountId}:${label}`
        ]
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Backwards-compatible alias (kept)
  router.post('/sessions/restore', async (req, res) => {
    const { accountId, label } = req.body;
    if (!accountId || !label) return res.status(400).json({ error: 'accountId and label are required' });

    try {
      const result = await sessionManager.initSession(accountId, label);
      res.json({ ...result, message: 'Session restoration attempted. Check WebSocket for status.' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/sessions/restore-all', async (_req, res) => {
    try {
      const summary = await sessionManager.autoRestoreAllSessions();
      res.json({ message: `Attempted to restore ${summary.total} sessions`, ...summary });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/sessions/destroy', async (req, res) => {
    const { accountId, label } = req.body;
    if (!accountId || !label) return res.status(400).json({ error: 'accountId and label are required' });

    try {
      const result = await sessionManager.destroySession(accountId, label);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/sessions/status', (req, res) => {
    const { accountId, label } = req.query;
    if (!accountId || !label) return res.status(400).json({ error: 'accountId and label are required' });
    res.json(sessionManager.getSessionStatus(accountId, label));
  });

  return router;
}

import { Router } from 'express';


export function createSessionRoutes(sessionManager, io) {
  const router = Router();

  // Get all active sessions
  router.get('/sessions', (req, res) => {
    res.json(sessionManager.getAllSessions());
  });

  // Get detected sessions (from filesystem)
  router.get('/sessions/detected', (req, res) => {
    res.json(sessionManager.detectSessions());
  });

  // Initialize a session with WebSocket QR streaming
  router.post('/sessions/init', async (req, res) => {
    const { accountId, label } = req.body;
    
    if (!accountId || !label) {
      return res.status(400).json({ error: 'accountId and label are required' });
    }
    
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

  // Restore a specific session
  router.post('/sessions/restore', async (req, res) => {
    const { accountId, label } = req.body;
    
    if (!accountId || !label) {
      return res.status(400).json({ error: 'accountId and label are required' });
    }
    
    try {
      const result = await sessionManager.initSession(accountId, label);
      res.json({
        ...result,
        message: 'Session restoration attempted. Check WebSocket for status.'
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Restore all detected sessions
  router.post('/sessions/restore-all', async (req, res) => {
    try {
      const detectedSessions = sessionManager.detectSessions();
      const results = [];
      
      for (const session of detectedSessions) {
        try {
          const result = await sessionManager.initSession(session.accountId, session.label);
          results.push({
            accountId: session.accountId,
            label: session.label,
            status: 'restoration_attempted',
            result
          });
        } catch (error) {
          results.push({
            accountId: session.accountId,
            label: session.label,
            status: 'error',
            error: error.message
          });
        }
      }
      
      res.json({
        message: `Attempted to restore ${results.length} sessions`,
        results
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Destroy a session
  router.post('/sessions/destroy', async (req, res) => {
    const { accountId, label } = req.body;
    
    if (!accountId || !label) {
      return res.status(400).json({ error: 'accountId and label are required' });
    }
    
    try {
      const result = await sessionManager.destroySession(accountId, label);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get session status
  router.get('/sessions/status', (req, res) => {
    const { accountId, label } = req.query;
    
    if (!accountId || !label) {
      return res.status(400).json({ error: 'accountId and label are required' });
    }
    
    res.json(sessionManager.getSessionStatus(accountId, label));
  });

  return router;
}
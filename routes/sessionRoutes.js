import { Router } from 'express';
import {
  assertAccountActiveAndMember,
  assertAccountAdmin,
  handleAuthzError
} from '../lib/auth/authorize.js';

export function createSessionRoutes(sessionManager, io) {
  const router = Router();

  // NOTE: These two endpoints are server-wide. We require just an authenticated user.
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
      // Only Admin/Owner can init sessions for an account
      await assertAccountAdmin(accountId, req.auth.uid);

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
      if (error?.status) return handleAuthzError(res, error);
      return res.status(500).json({ error: error.message });
    }
  });

  // Backwards-compatible alias (kept)
  router.post('/sessions/restore', async (req, res) => {
    const { accountId, label } = req.body;
    if (!accountId || !label) return res.status(400).json({ error: 'accountId and label are required' });

    try {
      await assertAccountAdmin(accountId, req.auth.uid);

      const result = await sessionManager.initSession(accountId, label);
      res.json({ ...result, message: 'Session restoration attempted. Check WebSocket for status.' });
    } catch (error) {
      if (error?.status) return handleAuthzError(res, error);
      return res.status(500).json({ error: error.message });
    }
  });

  // Attempts to restore all detected sessions; will only restore those the caller can admin
  router.post('/sessions/restore-all', async (_req, res) => {
    try {
      const detected = sessionManager.detectSessions();
      const uid = _req.auth.uid;
      const results = [];

      for (const s of detected) {
        try {
          await assertAccountAdmin(s.accountId, uid);
          const result = await sessionManager.initSession(s.accountId, s.label);
          results.push({ accountId: s.accountId, label: s.label, status: 'restoration_attempted', result });
        } catch (e) {
          const errMsg = e?.status ? `unauthorized: ${e.message}` : (e?.message || 'error');
          results.push({ accountId: s.accountId, label: s.label, status: 'skipped', error: errMsg });
        }
      }
      res.json({ message: `Attempted to restore ${results.length} sessions`, results });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/sessions/destroy', async (req, res) => {
    const { accountId, label } = req.body;
    if (!accountId || !label) return res.status(400).json({ error: 'accountId and label are required' });

    try {
      await assertAccountAdmin(accountId, req.auth.uid);
      const result = await sessionManager.destroySession(accountId, label);
      res.json(result);
    } catch (error) {
      if (error?.status) return handleAuthzError(res, error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/sessions/status', async (req, res) => {
    const { accountId, label } = req.query;
    if (!accountId || !label) return res.status(400).json({ error: 'accountId and label are required' });

    try {
      // Membership is enough to read status
      await assertAccountActiveAndMember(String(accountId), req.auth.uid);
      res.json(sessionManager.getSessionStatus(String(accountId), String(label)));
    } catch (error) {
      if (error?.status) return handleAuthzError(res, error);
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

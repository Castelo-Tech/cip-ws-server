import { Router } from 'express';
import { assertSessionPermission, handleAuthzError } from '../lib/auth/authorize.js';

export function createContactRoutes(sessionManager, io) {
  const router = Router();
  const contactsManager = sessionManager.getContactsManager
    ? sessionManager.getContactsManager()
    : null;

  if (!contactsManager) {
    throw new Error('ContactsManager not available on sessionManager. Please add getContactsManager().');
  }

  router.get('/sessions/:accountId/:label/contacts', async (req, res) => {
    const { accountId, label } = req.params;
    const { type = 'my', search = '', limit } = req.query;
    const lim = limit ? parseInt(limit) : undefined;

    try {
      await assertSessionPermission(accountId, label, req.auth.uid, 'viewContacts');
      const data = await contactsManager.listFilteredContacts(accountId, label, {
        type: String(type),
        search: String(search || '').trim(),
        limit: lim
      });
      res.json(data);
    } catch (err) {
      if (err?.status) return handleAuthzError(res, err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions/:accountId/:label/contacts/lookup', async (req, res) => {
    const { accountId, label } = req.params;
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Query param "number" is required' });

    try {
      await assertSessionPermission(accountId, label, req.auth.uid, 'viewContacts');
      const result = await contactsManager.lookupNumber(accountId, label, String(number));
      res.json(result);
    } catch (err) {
      if (err?.status) return handleAuthzError(res, err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

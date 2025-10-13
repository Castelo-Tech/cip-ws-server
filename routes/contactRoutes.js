import { Router } from 'express';

export function createContactRoutes(sessionManager, io) {
  const router = Router();
  const contactsManager = sessionManager.getContactsManager
    ? sessionManager.getContactsManager()
    : null;

  if (!contactsManager) {
    throw new Error('ContactsManager not available on sessionManager. Please add getContactsManager().');
  }

  // GET contacts with optional filters
  // ?type=all|my|business|waOnly  (default: my)
  // ?search=...                   (contains match in name/pushname/number)
  // ?limit=100&cursor=...         (cursor reserved; not persisted yet)
  router.get('/sessions/:accountId/:label/contacts', async (req, res) => {
    const { accountId, label } = req.params;
    const { type = 'my', search = '', limit } = req.query;
    const lim = limit ? parseInt(limit) : undefined;

    try {
      const data = await contactsManager.listFilteredContacts(accountId, label, {
        type: String(type),
        search: String(search || '').trim(),
        limit: lim
      });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions/:accountId/:label/contacts/lookup', async (req, res) => {
    const { accountId, label } = req.params;
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Query param "number" is required' });

    try {
      const result = await contactsManager.lookupNumber(accountId, label, String(number));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

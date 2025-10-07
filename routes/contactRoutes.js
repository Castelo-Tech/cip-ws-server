import { Router } from 'express';

export function createContactRoutes(sessionManager, io) {
  // io is accepted for consistency with your server wiring; not used here.
  const router = Router();
  const contactsManager = sessionManager.getContactsManager
    ? sessionManager.getContactsManager()
    : null;

  if (!contactsManager) {
    throw new Error('ContactsManager not available on sessionManager. Please add getContactsManager().');
  }

  // GET /api/sessions/:accountId/:label/contacts
  router.get('/sessions/:accountId/:label/contacts', async (req, res) => {
    const { accountId, label } = req.params;
    try {
      const data = await contactsManager.listFilteredContacts(accountId, label);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/sessions/:accountId/:label/contacts/lookup?number=E164
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

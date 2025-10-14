import { Router } from 'express';
import { assertSessionPermission, handleAuthzError } from '../lib/auth/authorize.js';

export function createConversationRoutes(sessionManager, io) {
  const router = Router();
  const chatManager = sessionManager.getChatManager();
  const contactsManager = sessionManager.getContactsManager();

  router.get('/sessions/:accountId/:label/conversations', async (req, res) => {
    const { accountId, label } = req.params;
    const { search = '', onlyContacts = '', limit } = req.query;

    const searchTerm = String(search).trim().toLowerCase();
    const allowedUsers = new Set(
      String(onlyContacts || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => s.replace(/[^\d]/g, ''))
    );
    const hasAllowList = allowedUsers.size > 0;
    const lim = limit ? parseInt(limit) : undefined;

    try {
      await assertSessionPermission(accountId, label, req.auth.uid, 'viewMessages');

      const chats = await chatManager.getChats(accountId, label);
      const displayMap = await contactsManager.getDisplayMap(accountId, label);

      let results = chats
        .filter((c) => {
          if (hasAllowList) {
            if (c.isGroup) return false;
            return allowedUsers.has(String(c.id?.split('@')[0] || '').replace(/[^\d]/g, '')) ||
                   allowedUsers.has(String(c.lastMessage?.author || '').replace(/[^\d]/g, ''));
          }
          return true;
        })
        .map((c) => {
          const wid = c.isGroup ? null : `${c.id.split('@')[0]}@c.us`;
          const display = wid ? displayMap.get(wid) : null;
          const displayName = c.isGroup
            ? (c.name || 'Group')
            : (display?.name || display?.pushname || c.name || c.id);
          return {
            chatId: c.id,
            name: displayName,
            isGroup: c.isGroup,
            unreadCount: c.unreadCount,
            timestamp: c.timestamp,
            lastMessage: c.lastMessage ? {
              id: c.lastMessage.id,
              body: c.lastMessage.body,
              type: c.lastMessage.type,
              fromMe: c.lastMessage.fromMe,
              timestamp: c.lastMessage.timestamp,
              hasMedia: c.lastMessage.hasMedia
            } : null,
            contactDisplay: display ? {
              id: wid,
              name: display.name || null,
              pushname: display.pushname || null,
              user: display.user || null
            } : null
          };
        });

      if (searchTerm) {
        results = results.filter(r => {
          const hay = `${r.name || ''} ${r.lastMessage?.body || ''}`.toLowerCase();
          return hay.includes(searchTerm);
        });
      }

      if (lim && lim > 0) results = results.slice(0, lim);

      res.json({ conversations: results });
    } catch (error) {
      if (error?.status) return handleAuthzError(res, error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

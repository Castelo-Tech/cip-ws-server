import { EventEmitter } from 'events';

export class ContactsManager extends EventEmitter {
  constructor(sessionManager) {
    super();
    this.sessionManager = sessionManager;
  }

  keyOf(accountId, label) {
    return `${accountId}::${label}`;
  }

  // Only @c.us, isWAContact === true, isMyContact === true, isBusiness === false
  async listFilteredContacts(accountId, label) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    if (!client) throw new Error('Session not found');

    try {
      const contacts = await client.getContacts();
      const filtered = contacts
        .filter(c => {
          const server = c?.id?.server || '';
          return (
            server === 'c.us' &&
            (typeof c.isWAContact === 'boolean' ? c.isWAContact : true) &&
            c.isMyContact === true &&
            c.isBusiness !== true
          );
        })
        .map(c => ({
          id: c.id?._serialized,
          server: c.id?.server,
          user: c.id?.user,
          name: c.name || null,
          pushname: c.pushname || null,
          isWAContact: typeof c.isWAContact === 'boolean' ? c.isWAContact : true,
          isMyContact: !!c.isMyContact,
          isBusiness: !!c.isBusiness
        }));

      return filtered;
    } catch (err) {
      throw new Error(`Failed to list contacts: ${err.message}`);
    }
  }

  // Lookup: uses client.getNumberId(number). Returns null if not registered.
  async lookupNumber(accountId, label, number) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    if (!client) throw new Error('Session not found');

    const normalized = String(number || '').replace(/[^\d]/g, '');
    if (!normalized) throw new Error('Invalid number');

    try {
      const wid = await client.getNumberId(normalized);
      if (!wid) {
        return { input: number, normalized, isRegistered: false };
      }

      const widStr = wid?._serialized || `${wid.user}@${wid.server || 'c.us'}`;

      let contact = null;
      try {
        contact = await client.getContactById(widStr);
      } catch {
        // not fatal
      }

      return {
        input: number,
        normalized,
        isRegistered: true,
        wid: {
          user: wid.user,
          server: wid.server,
          _serialized: wid._serialized
        },
        contact: contact ? {
          id: contact.id?._serialized,
          server: contact.id?.server,
          user: contact.id?.user,
          name: contact.name || null,
          pushname: contact.pushname || null,
          isWAContact: typeof contact.isWAContact === 'boolean' ? contact.isWAContact : true,
          isMyContact: !!contact.isMyContact,
          isBusiness: !!contact.isBusiness
        } : null
      };
    } catch (err) {
      throw new Error(`Lookup failed: ${err.message}`);
    }
  }
}

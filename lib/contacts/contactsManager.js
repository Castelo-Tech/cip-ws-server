import { EventEmitter } from 'events';

export class ContactsManager extends EventEmitter {
  constructor(sessionManager) {
    super();
    this.sessionManager = sessionManager;
    this.displayCache = new Map(); // key -> { ts, map: Map<wid, {name,pushname,user}> }
    this.DISPLAY_TTL_MS = 60 * 1000; // 60s
  }

  keyOf(accountId, label) {
    return `${accountId}::${label}`;
  }

  _getClient(accountId, label) {
    const key = this.keyOf(accountId, label);
    const client = this.sessionManager.clients.get(key);
    if (!client) throw new Error('Session not found');
    return client;
  }

  async listFilteredContacts(accountId, label, opts = {}) {
    const client = this._getClient(accountId, label);
    const { type = 'my', search = '', limit } = opts;
    const searchTerm = String(search || '').trim().toLowerCase();

    try {
      const contacts = await client.getContacts();
      let filtered = contacts.filter(c => {
        const server = c?.id?.server || '';
        const isWa = (typeof c.isWAContact === 'boolean' ? c.isWAContact : true);
        const isMy = !!c.isMyContact;
        const isBiz = !!c.isBusiness;

        // type filter
        if (type === 'my' && (!isWa || !isMy || isBiz || server !== 'c.us')) return false;
        if (type === 'business' && (!isWa || !isBiz)) return false;
        if (type === 'waOnly' && !isWa) return false;
        if (type === 'all') {
          // no-op
        } else if (!['my','business','waOnly'].includes(type)) {
          // default behavior == 'my'
          if (!isWa || !isMy || isBiz || server !== 'c.us') return false;
        }

        // search filter
        if (searchTerm) {
          const hay = `${c.name || ''} ${c.pushname || ''} ${c.id?.user || ''}`.toLowerCase();
          if (!hay.includes(searchTerm)) return false;
        }

        return true;
      });

      if (limit && limit > 0) filtered = filtered.slice(0, limit);

      return filtered.map(c => ({
        id: c.id?._serialized,
        server: c.id?.server,
        user: c.id?.user,
        name: c.name || null,
        pushname: c.pushname || null,
        isWAContact: typeof c.isWAContact === 'boolean' ? c.isWAContact : true,
        isMyContact: !!c.isMyContact,
        isBusiness: !!c.isBusiness
      }));
    } catch (err) {
      throw new Error(`Failed to list contacts: ${err.message}`);
    }
  }

  async lookupNumber(accountId, label, number) {
    const client = this._getClient(accountId, label);
    const normalized = String(number || '').replace(/[^\d]/g, '');
    if (!normalized) throw new Error('Invalid number');

    try {
      const wid = await client.getNumberId(normalized);
      if (!wid) {
        return { input: number, normalized, isRegistered: false };
      }
      const widStr = wid?._serialized || `${wid.user}@${wid.server || 'c.us'}`;
      let contact = null;
      try { contact = await client.getContactById(widStr); } catch {}

      return {
        input: number,
        normalized,
        isRegistered: true,
        wid: { user: wid.user, server: wid.server, _serialized: wid._serialized },
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

  // Display map (wid -> {name,pushname,user}), cached briefly
  async getDisplayMap(accountId, label) {
    const key = this.keyOf(accountId, label);
    const now = Date.now();
    const cached = this.displayCache.get(key);
    if (cached && (now - cached.ts) < this.DISPLAY_TTL_MS) return cached.map;

    const client = this._getClient(accountId, label);
    const contacts = await client.getContacts();
    const map = new Map();
    for (const c of contacts) {
      const wid = c.id?._serialized;
      if (wid) map.set(wid, { name: c.name || null, pushname: c.pushname || null, user: c.id?.user || null });
    }
    this.displayCache.set(key, { ts: now, map });
    return map;
  }
}

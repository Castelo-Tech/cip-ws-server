import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import wwebjs from 'whatsapp-web.js';
import { ChatManager } from '../chats/chatManager.js';
import { ContactsManager } from '../contacts/contactsManager.js';

const { Client, LocalAuth } = wwebjs;

export class SessionManager extends EventEmitter {
  constructor(dataPath = './.wwebjs_auth') {
    super();
    this.clients = new Map();
    this.states = new Map();
    this.qrs = new Map();
    this.selfIds = new Map();
    this.dataPath = dataPath;
    this.chatManager = new ChatManager(this);
    this.contactsManager = new ContactsManager(this);

    this.log('SYSTEM', 'SessionManager initialized', { dataPath: this.dataPath });
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }
  }

  log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`, Object.keys(data).length ? data : '');
  }

  keyOf(accountId, label) {
    return `${accountId}::${label}`;
  }

  parseSessionDir(dirName) {
    if (!dirName?.startsWith('session-')) return null;
    const sessionId = dirName.replace('session-', '');
    if (sessionId.includes('__')) {
      const [accountId, label] = sessionId.split('__');
      if (accountId && label) return { accountId, label };
    }
    if (sessionId === 'default-client') return { accountId: 'default', label: 'main' };
    return { accountId: 'legacy', label: sessionId };
  }

  getAllSessions() {
    const sessions = [];
    for (const [key] of this.clients.entries()) {
      const [accountId, label] = key.split('::');
      sessions.push({
        accountId,
        label,
        status: this.states.get(key) || 'unknown',
        waId: this.selfIds.get(key) || null,
        hasQr: this.qrs.has(key)
      });
    }
    return sessions;
  }

  bindEvents(accountId, label, client) {
    const key = this.keyOf(accountId, label);

    client.on('qr', (qr) => {
      this.log('QR', `QR received for ${accountId}::${label}`);
      this.qrs.set(key, qr);
      this.states.set(key, 'scanning');
      this.emit('qr', { accountId, label, qr });
      this.emit('status', { accountId, label, status: 'scanning', hasQr: true });
    });

    client.on('authenticated', () => {
      this.log('AUTH', `Authenticated for ${accountId}::${label}`);
      this.qrs.delete(key);
      this.states.set(key, 'authenticated');
      this.emit('status', { accountId, label, status: 'authenticated', hasQr: false });
    });

    client.on('auth_failure', (msg) => {
      this.log('AUTH', `Auth failure for ${accountId}::${label}`, { error: msg });
      this.states.set(key, 'auth_failure');
      this.emit('status', { accountId, label, status: 'auth_failure', error: msg });
    });

    client.on('ready', () => {
      this.log('READY', `Ready for ${accountId}::${label}`);
      this.states.set(key, 'ready');
      this.selfIds.set(key, client.info.wid.user);
      this.emit('status', {
        accountId,
        label,
        status: 'ready',
        hasQr: false,
        waId: client.info.wid.user
      });
    });

    client.on('disconnected', (reason) => {
      this.log('DISCONNECT', `Disconnected for ${accountId}::${label}`, { reason });
      this.states.set(key, 'disconnected');
      this.selfIds.delete(key);
      this.emit('status', { accountId, label, status: 'disconnected', reason });
    });

    // message_create fires for in/out. We keep your existing behavior
    // and add a relayer log for inbound (text/media/voice).
    client.on('message_create', (message) => {
      this.log('MESSAGE', `Message from ${accountId}::${label}`, {
        from: message.from,
        body: message.body?.substring(0, 50)
      });

      // Emit for sockets/consumers (unchanged)
      this.emit('message', {
        accountId,
        label,
        message: {
          id: message.id._serialized,
          from: message.from,
          to: message.to,
          body: message.body,
          type: message.type,
          fromMe: message.fromMe,
          timestamp: message.timestamp,
          hasMedia: message.hasMedia
        }
      });

      // Relayer hook for inbound-only (text, media, voice all included here)
      if (!message.fromMe) {
        this.log('RELAYER', 'passing to endpoint', {
          accountId, label,
          messageId: message.id?._serialized,
          type: message.type,
          from: message.from,
          timestamp: message.timestamp,
          hasMedia: !!message.hasMedia
        });
        // ⬆ Later: place your outbound HTTP call/queue publish here.
      }
    });
  }

  async initSession(accountId, label) {
    const key = this.keyOf(accountId, label);
    if (this.clients.has(key)) {
      const state = this.states.get(key);
      const currentQr = this.qrs.get(key);
      this.log('SESSION', 'Session already exists', { accountId, label, state, hasQr: !!currentQr });
      return { accountId, label, status: state, exists: true, hasQr: !!currentQr };
    }

    if (this.clients.size >= 5) throw new Error('Maximum session limit (5) reached');

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: `${accountId}__${label}`, dataPath: this.dataPath }),
      puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] }
    });

    this.clients.set(key, client);
    this.states.set(key, 'initializing');
    this.bindEvents(accountId, label, client);

    try {
      await client.initialize();
      this.log('SESSION', 'Session initialized successfully', { accountId, label });
      return { accountId, label, status: 'initializing', exists: false };
    } catch (error) {
      this.clients.delete(key);
      this.states.delete(key);
      this.log('ERROR', 'Failed to initialize session', { accountId, label, error: error.message });
      throw error;
    }
  }

  async destroySession(accountId, label) {
    const key = this.keyOf(accountId, label);
    const client = this.clients.get(key);

    if (client) {
      try { await client.destroy(); } catch (error) {
        this.log('ERROR', 'Error destroying client', { accountId, label, error: error.message });
      }
      this.clients.delete(key);
      this.states.delete(key);
      this.qrs.delete(key);
      this.selfIds.delete(key);
    }

    try {
      const sessionDir = path.join(this.dataPath, `session-${accountId}__${label}`);
      if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (error) {
      this.log('ERROR', 'Error cleaning session directory', { accountId, label, error: error.message });
    }

    this.emit('session_destroyed', { accountId, label });
    return { accountId, label, destroyed: true };
  }

  getSessionStatus(accountId, label) {
    const key = this.keyOf(accountId, label);
    return {
      accountId,
      label,
      status: this.states.get(key) || 'not_found',
      hasQr: this.qrs.has(key),
      waId: this.selfIds.get(key) || null
    };
  }

  getChatManager() { return this.chatManager; }
  getContactsManager() { return this.contactsManager; }

  detectSessions() {
    try {
      const items = fs.readdirSync(this.dataPath, { withFileTypes: true });
      const sessions = [];
      for (const item of items) {
        if (!item.isDirectory() || !item.name.startsWith('session-')) continue;
        const sessionInfo = this.parseSessionDir(item.name);
        if (sessionInfo?.accountId && sessionInfo?.label) {
          sessions.push({
            directory: item.name,
            accountId: sessionInfo.accountId,
            label: sessionInfo.label,
            active: this.clients.has(this.keyOf(sessionInfo.accountId, sessionInfo.label))
          });
        }
      }
      return sessions;
    } catch (error) {
      this.log('ERROR', 'Error detecting sessions', { error: error.message });
      return [];
    }
  }

  async autoRestoreAllSessions() {
    const detectedSessions = this.detectSessions();
    if (detectedSessions.length === 0) {
      this.log('SYSTEM', 'No sessions detected for auto-restore');
      return { restored: 0, total: 0, results: [] };
    }

    this.log('SYSTEM', `Auto-restoring ${detectedSessions.length} detected sessions`);
    let restoredCount = 0;
    const results = [];

    for (const session of detectedSessions) {
      try {
        if (!session.active) {
          await this.initSession(session.accountId, session.label);
          this.log('SYSTEM', `Auto-restored session: ${session.accountId}::${session.label}`);
          restoredCount++;
          results.push({ accountId: session.accountId, label: session.label, status: 'restored' });
        } else {
          this.log('SYSTEM', `Session already active: ${session.accountId}::${session.label}`);
          results.push({ accountId: session.accountId, label: session.label, status: 'already_active' });
        }
      } catch (error) {
        this.log('ERROR', `Failed to auto-restore session: ${session.accountId}::${session.label}`, { error: error.message });
        results.push({ accountId: session.accountId, label: session.label, status: 'error', error: error.message });
      }
    }

    this.log('SYSTEM', `Auto-restore completed: ${restoredCount}/${detectedSessions.length} sessions restored`);
    return { restored: restoredCount, total: detectedSessions.length, results };
  }
}

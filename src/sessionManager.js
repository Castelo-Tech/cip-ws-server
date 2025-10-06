const { Client, LocalAuth, MessageMedia, Location, Contact, Poll, Buttons, List } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');

/**
 * Module responsible for managing WhatsApp sessions using whatsapp‑web.js.
 * It supports creating multiple sessions (up to a defined limit), reloading
 * existing sessions from the local auth directory, broadcasting events to
 * connected WebSocket clients and HTTP callbacks, and exposing helper
 * functions to call client methods such as sending messages.
 */

// Directory where LocalAuth stores each session's data.  When a session is
// created with a given clientId, whatsapp‑web.js will create a folder
// `.wwebjs_auth/${clientId}` containing credentials and metadata.  On
// initialization we scan this directory for existing sessions and attempt
// to restore them automatically.
const AUTH_ROOT = path.join(process.cwd(), '.wwebjs_auth');

// Maximum number of concurrent sessions allowed.  Attempts to create more
// than this number of sessions will throw an error.  You can override
// this value via the environment variable MAX_SESSIONS (useful for
// deployments where the limit needs to be configurable).
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '5', 10);

// In‑memory registry of all active sessions.  Each key is a sessionId and
// the value is an object containing the whatsapp client, metadata and
// helper structures such as a set of WebSocket connections.
const sessions = {};

// Fetch shim.  In Node 18+ the global fetch API is available.  When running
// on older versions of Node the optional dependency `node-fetch` will be
// dynamically imported on first use.  This avoids a hard dependency on
// node-fetch when it is not needed.
let _fetchImpl = typeof fetch === 'function' ? fetch : null;
async function getFetch() {
  if (_fetchImpl) return _fetchImpl;
  const mod = await import('node-fetch');
  _fetchImpl = mod.default || mod;
  return _fetchImpl;
}

/**
 * Utility used to deeply clone objects prior to JSON serialisation.  The
 * built‑in structuredClone is available in Node 17+ and correctly
 * handles complex data structures without circular references.  If not
 * available it falls back to a JSON clone.
 * @param {any} obj The object to clone
 * @returns {any} A cloned copy of the input
 */
function deepClone(obj) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch (e) {
      // fall back
    }
  }
  return JSON.parse(JSON.stringify(obj, (_k, v) => {
    // Convert BigInt to number to avoid JSON issues
    return typeof v === 'bigint' ? Number(v) : v;
  }));
}

/**
 * Notify all listeners (WebSocket clients and callback URL) about an
 * event occurring on a session.  The data will be cloned to avoid
 * accidental mutations or circular references.  Errors in callback
 * notifications are silently swallowed to avoid interrupting the main
 * application flow.
 *
 * @param {string} sessionId The session identifier
 * @param {string} event Event name
 * @param {any} data Event payload
 */
async function notifyEvent(sessionId, event, data) {
  const session = sessions[sessionId];
  if (!session) return;
  const payload = {
    sessionId,
    event,
    data: deepClone(data)
  };
  const message = JSON.stringify(payload);
  // Broadcast to WebSocket clients
  for (const ws of session.sockets) {
    try {
      ws.send(message);
    } catch (e) {
      // ignore broken connections
    }
  }
  // Invoke callback if configured and enabled.  Use dynamic fetch loader
  if (session.callbackUrl && session.callbackEnabled) {
    try {
      const fetchImpl = await getFetch();
      await fetchImpl(session.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: message,
      });
    } catch (_err) {
      // swallow callback errors silently
    }
  }
}

/**
 * Initialise a new WhatsApp client for a session.  This function sets up
 * event listeners to update internal state (ready status, last QR code)
 * and to forward all relevant events through the notifyEvent helper.
 *
 * @param {string} sessionId The unique identifier for the session
 * @returns {Promise<Object>} Metadata about the created session
 */
async function createSession(sessionId) {
  if (Object.keys(sessions).length >= MAX_SESSIONS) {
    throw new Error(`Cannot create session. Maximum number of sessions (${MAX_SESSIONS}) reached.`);
  }
  if (sessions[sessionId]) {
    throw new Error(`Session with id '${sessionId}' already exists`);
  }
  // Ensure the auth root directory exists
  fs.mkdirSync(AUTH_ROOT, { recursive: true });
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: '.wwebjs_auth' }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
    // The ffmpegPath can be provided via env if available on the host; it's used when converting
    // videos to stickers.  If not provided, whatsapp‑web.js will attempt to find a suitable binary.
    ffmpegPath: process.env.FFMPEG_PATH
  });
  const session = {
    id: sessionId,
    client,
    ready: false,
    lastQr: null,
    sockets: new Set(),
    callbackUrl: null,
    callbackEnabled: false,
    info: null,
  };
  // Register event listeners
  client.on('qr', (qr) => {
    session.lastQr = qr;
    notifyEvent(sessionId, 'qr', { qr });
  });
  client.on('authenticated', () => {
    notifyEvent(sessionId, 'authenticated', {});
  });
  client.on('auth_failure', (msg) => {
    notifyEvent(sessionId, 'auth_failure', { message: msg });
  });
  client.on('ready', () => {
    session.ready = true;
    session.info = client.info;
    notifyEvent(sessionId, 'ready', { info: deepClone(client.info) });
  });
  client.on('disconnected', (reason) => {
    session.ready = false;
    notifyEvent(sessionId, 'disconnected', { reason });
  });
  // Forward other events generically
  const events = [
    'message', 'message_ack', 'message_create', 'message_revoke_me', 'message_revoke_everyone',
    'message_ciphertext', 'message_edit', 'media_uploaded', 'group_join', 'group_leave',
    'group_update', 'change_state', 'contact_changed', 'group_admin_changed',
    'group_membership_request', 'vote_update', 'incoming_call', 'change_battery',
    'chat_archived', 'chat_removed', 'chat_unarchived', 'message_reaction', 'code'
  ];
  events.forEach(evt => {
    client.on(evt, async (...args) => {
      // attempt to serialise payloads.  When multiple arguments are provided,
      // wrap them in an array for consistency.
      let data = args.length === 1 ? args[0] : args;
      notifyEvent(sessionId, evt, data);
    });
  });
  await client.initialize();
  sessions[sessionId] = session;
  return { id: sessionId };
}

/**
 * Destroy an existing session.  This will close the Puppeteer browser and
 * remove the session from the in‑memory registry.  The auth files on
 * disk remain untouched so the session can be restored later.  WebSocket
 * clients connected to the session will be closed.
 *
 * @param {string} sessionId The identifier of the session to destroy
 * @returns {Promise<void>}
 */
async function destroySession(sessionId) {
  const session = sessions[sessionId];
  if (!session) {
    throw new Error(`Session ${sessionId} does not exist`);
  }
  try {
    await session.client.destroy();
  } catch (e) {
    // ignore errors during destruction
  }
  // Close all sockets
  for (const ws of session.sockets) {
    try { ws.close(); } catch (_e) {}
  }
  delete sessions[sessionId];
}

/**
 * Return a list of currently active sessions along with high‑level
 * information such as readiness and connection state.  This does not
 * include any sensitive data.
 *
 * @returns {Array<Object>} List of session summaries
 */
function listSessions() {
  return Object.values(sessions).map(session => ({
    id: session.id,
    ready: session.ready,
    hasQr: !!session.lastQr,
    callbackUrl: session.callbackUrl,
    callbackEnabled: session.callbackEnabled,
    info: session.info ? deepClone(session.info) : null,
  }));
}

/**
 * Retrieve a session object by its id.  Returns undefined if not found.
 *
 * @param {string} sessionId The session identifier
 * @returns {Object|undefined}
 */
function getSession(sessionId) {
  return sessions[sessionId];
}

/**
 * Attempt to restore all sessions by scanning the auth directory for
 * existing subfolders.  Each subfolder corresponds to a previously
 * authenticated LocalAuth clientId.  Sessions are restored lazily on
 * startup.  If a session fails to initialise it will be logged and
 * ignored.
 */
async function initExistingSessions() {
  if (!fs.existsSync(AUTH_ROOT)) return;
  const entries = fs.readdirSync(AUTH_ROOT, { withFileTypes: true });
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const sessionId = dirent.name;
    try {
      await createSession(sessionId);
      console.log(`Restored session '${sessionId}'`);
    } catch (err) {
      console.error(`Failed to restore session '${sessionId}':`, err.message);
    }
  }
}

/**
 * Set or update the callback configuration for a given session.  A
 * callback URL can be used to forward all events for the session to an
 * external HTTP endpoint.  The callback must accept POST requests with
 * the event payload.  You can enable or disable callbacks using the
 * `enabled` flag.
 *
 * @param {string} sessionId The session identifier
 * @param {string|null} url The callback URL to invoke for events.  Use null to clear
 * @param {boolean} enabled Whether the callback should be invoked
 */
function setCallback(sessionId, url, enabled) {
  const session = sessions[sessionId];
  if (!session) {
    throw new Error(`Session ${sessionId} does not exist`);
  }
  session.callbackUrl = url;
  session.callbackEnabled = enabled;
}

/**
 * Send a message from a session.  Supports text, media, location, polls and
 * contacts.  For media messages the caller must provide a `media` object
 * in the options with the following properties: `data` (base64 encoded
 * string without data URI prefix), `mimetype`, and `filename`.  The
 * `sendAudioAsVoice` option can be used to mark audio messages as voice
 * notes.  Additional message options supported by whatsapp‑web.js can be
 * passed through the options object.
 *
 * @param {string} sessionId The session id
 * @param {string} chatId The chat (user or group) id to send to
 * @param {string|Object} content The message content (string or placeholder)
 * @param {Object} options Additional send options
 * @returns {Promise<Object>} The message payload returned by whatsapp‑web.js
 */
async function sendMessage(sessionId, chatId, content, options = {}) {
  const session = sessions[sessionId];
  if (!session || !session.ready) {
    throw new Error(`Session ${sessionId} is not ready`);
  }
  const client = session.client;
  let payload = content;
  // If the caller passed a media descriptor, construct a MessageMedia
  if (options && options.media) {
    const { data, mimetype, filename } = options.media;
    payload = new MessageMedia(mimetype, data, filename || 'media');
  } else if (content && typeof content === 'object') {
    // Support sending locations, polls or contact cards directly
    if (content.type === 'location' && content.latitude && content.longitude) {
      payload = new Location(content.latitude, content.longitude, {
        name: content.name,
        address: content.address,
      });
    } else if (content.type === 'poll' && content.name && Array.isArray(content.options)) {
      payload = new Poll(content.name, content.options, content.extra || {});
    } else if (content.type === 'contact' && content.phone) {
      payload = new Contact(content.phone);
    } else if (content.type === 'buttons') {
      payload = new Buttons(content.body, content.buttons, content.title, content.footer);
    } else if (content.type === 'list') {
      payload = new List(content.body, content.buttonText, content.sections, content.title, content.footer);
    }
  }
  const msg = await client.sendMessage(chatId, payload, options);
  return deepClone(msg);
}

/**
 * Generic method invocation on the underlying Client object.  Allows callers
 * to execute any method available on the Client API by name.  Arguments
 * must be provided as an array and will be forwarded as‑is.  Use with
 * caution: incorrect method names or parameters will cause the promise to
 * reject.
 *
 * @param {string} sessionId The session identifier
 * @param {string} method The Client method name to call
 * @param {Array<any>} args Arguments to pass to the method
 * @returns {Promise<any>} The result of the invoked method
 */
async function invoke(sessionId, method, args = []) {
  const session = sessions[sessionId];
  if (!session || !session.ready) {
    throw new Error(`Session ${sessionId} is not ready`);
  }
  const client = session.client;
  const fn = client[method];
  if (typeof fn !== 'function') {
    throw new Error(`Method '${method}' does not exist on Client`);
  }
  const result = await fn.apply(client, args);
  return deepClone(result);
}

/**
 * Retrieve chats for a session.  This returns a simplified list of
 * chats containing id, name and whether the chat is a group or channel.
 * The full chat objects can be very large and contain circular
 * references so it's better to expose only essential data to clients.
 *
 * @param {string} sessionId The session identifier
 * @returns {Promise<Array<Object>>}
 */
async function getChats(sessionId) {
  const session = sessions[sessionId];
  if (!session || !session.ready) {
    throw new Error(`Session ${sessionId} is not ready`);
  }
  const chats = await session.client.getChats();
  return chats.map(chat => ({
    id: chat.id._serialized || chat.id,
    name: chat.name,
    isGroup: chat.isGroup,
    isChannel: chat.isChannel,
    timestamp: chat.timestamp
  }));
}

/**
 * Retrieve contacts for a session.  Returns simplified objects with
 * identifier and name to avoid leaking unnecessary data.
 *
 * @param {string} sessionId The session identifier
 * @returns {Promise<Array<Object>>}
 */
async function getContacts(sessionId) {
  const session = sessions[sessionId];
  if (!session || !session.ready) {
    throw new Error(`Session ${sessionId} is not ready`);
  }
  const contacts = await session.client.getContacts();
  return contacts.map(c => ({
    id: c.id._serialized || c.id,
    name: c.name || c.pushname || c.shortName || c.number,
    isGroup: c.isGroup,
    isBusiness: c.isBusiness
  }));
}

/**
 * Fetch messages for a chat.  Accepts optional search options object
 * compatible with whatsapp‑web.js fetchMessages method.  Returns an
 * array of simplified message objects.
 *
 * @param {string} sessionId The session identifier
 * @param {string} chatId Chat identifier (e.g. 123456789@c.us)
 * @param {Object} searchOptions Options passed to fetchMessages (limit, fromId, etc.)
 * @returns {Promise<Array<Object>>}
 */
async function getMessages(sessionId, chatId, searchOptions = {}) {
  const session = sessions[sessionId];
  if (!session || !session.ready) {
    throw new Error(`Session ${sessionId} is not ready`);
  }
  const chat = await session.client.getChatById(chatId);
  const messages = await chat.fetchMessages(searchOptions);
  return messages.map(m => ({
    id: m.id._serialized || m.id,
    from: m.from,
    to: m.to,
    author: m.author,
    body: m.body,
    type: m.type,
    timestamp: m.timestamp,
    fromMe: m.fromMe,
    hasMedia: m.hasMedia,
  }));
}

module.exports = {
  createSession,
  destroySession,
  listSessions,
  getSession,
  initExistingSessions,
  setCallback,
  sendMessage,
  invoke,
  getChats,
  getContacts,
  getMessages,
  MAX_SESSIONS,
};
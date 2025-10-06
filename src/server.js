const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

// Import session manager to control WhatsApp sessions and expose helper methods
const sessionManager = require('./sessionManager');

// Create the Express application
const app = express();
app.use(express.json({ limit: '100mb' }));
app.use(cors());

// Create an HTTP server and attach WebSocket support
const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade requests.  Clients must specify a sessionId
// query parameter in the connection URL (e.g. ws://host/ws?sessionId=abc).
httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const sessionId = url.searchParams.get('sessionId');
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, sessionId);
  });
});

// When a WebSocket connection is established, bind it to the session
wss.on('connection', (ws, _req, sessionId) => {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    ws.close();
    return;
  }
  session.sockets.add(ws);
  ws.on('close', () => {
    session.sockets.delete(ws);
  });
});

/**
 * Generate a random identifier to be used as a session id when one is
 * not provided by the caller.  Uses the built‑in crypto module for
 * secure random UUIDs.
 *
 * @returns {string}
 */
function generateSessionId() {
  return crypto.randomUUID();
}

// API endpoints

/**
 * List all active sessions.
 */
app.get('/sessions', (_req, res) => {
  res.json(sessionManager.listSessions());
});

/**
 * Create a new session.  Optional body parameter `sessionId` allows
 * clients to specify a custom identifier.  Returns the created session id.
 */
app.post('/sessions', async (req, res) => {
  const requestedId = req.body && typeof req.body.sessionId === 'string' && req.body.sessionId.trim();
  const id = requestedId || generateSessionId();
  try {
    await sessionManager.createSession(id);
    res.status(201).json({ sessionId: id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Remove (destroy) a session
 */
app.delete('/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    await sessionManager.destroySession(sessionId);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * Get details about a specific session
 */
app.get('/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessionManager.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({
    id: session.id,
    ready: session.ready,
    lastQr: session.lastQr,
    callbackUrl: session.callbackUrl,
    callbackEnabled: session.callbackEnabled,
    info: session.info,
  });
});

/**
 * Retrieve the last QR code for a session, if available.  Useful when
 * initiating a new session.  The QR code is returned as plain text
 * payload that can be converted into a QR image by the client.
 */
app.get('/sessions/:sessionId/qr', (req, res) => {
  const { sessionId } = req.params;
  const session = sessionManager.getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.lastQr) return res.status(404).json({ error: 'No QR available' });
  res.json({ qr: session.lastQr });
});

/**
 * Configure a callback URL for a session.  The body must contain
 * `url` (string or null) and `enabled` (boolean).  When enabled,
 * all session events will be forwarded via HTTP POST to the provided
 * URL.
 */
app.post('/sessions/:sessionId/callback', (req, res) => {
  const { sessionId } = req.params;
  const { url, enabled } = req.body || {};
  try {
    sessionManager.setCallback(sessionId, url || null, Boolean(enabled));
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * Send a message from a session.  The request body must include
 * `chatId` and `content`.  Optionally an `options` object can
 * specify message send options (see whatsapp‑web.js docs) and a
 * `media` object for sending images/audio/video/documents encoded as
 * base64.  The response contains the sent message info.
 */
app.post('/sessions/:sessionId/send-message', async (req, res) => {
  const { sessionId } = req.params;
  const { chatId, content, options } = req.body || {};
  if (!chatId || !content) {
    return res.status(400).json({ error: 'chatId and content are required' });
  }
  try {
    const result = await sessionManager.sendMessage(sessionId, chatId, content, options || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Generic invoke endpoint.  Pass a method name on the Client and an
 * array of arguments.  Use responsibly; invalid method names or
 * parameters will return an error.  This endpoint exposes the full
 * power of whatsapp‑web.js to API consumers.
 */
app.post('/sessions/:sessionId/invoke', async (req, res) => {
  const { sessionId } = req.params;
  const { method, args } = req.body || {};
  if (!method || !Array.isArray(args)) {
    return res.status(400).json({ error: 'method (string) and args (array) are required' });
  }
  try {
    const result = await sessionManager.invoke(sessionId, method, args);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Fetch a simplified list of chats for a session
 */
app.get('/sessions/:sessionId/chats', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const chats = await sessionManager.getChats(sessionId);
    res.json(chats);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Fetch a simplified list of contacts for a session
 */
app.get('/sessions/:sessionId/contacts', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const contacts = await sessionManager.getContacts(sessionId);
    res.json(contacts);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Fetch messages for a chat.  Supports optional query parameters
 * `limit`, `fromId` and `direction` forwarded to whatsapp‑web.js
 * fetchMessages.  Returns simplified message objects.
 */
app.get('/sessions/:sessionId/chat/:chatId/messages', async (req, res) => {
  const { sessionId, chatId } = req.params;
  const { limit, fromId, direction } = req.query;
  const searchOptions = {};
  if (limit) searchOptions.limit = parseInt(limit, 10);
  if (fromId) searchOptions.fromId = fromId;
  if (direction) searchOptions.direction = direction;
  try {
    const messages = await sessionManager.getMessages(sessionId, chatId, searchOptions);
    res.json(messages);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Start the HTTP server only after attempting to restore existing sessions.
async function start() {
  await sessionManager.initExistingSessions();
  const port = process.env.PORT || 3000;
  httpServer.listen(port, () => {
    console.log(`WhatsApp server listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
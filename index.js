import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { SessionManager } from './lib/sessions/sessionManager.js';
import { createSessionRoutes } from './routes/sessionRoutes.js';
import { createChatRoutes } from './routes/chatRoutes.js';
import { createContactRoutes } from './routes/contactRoutes.js';
import { createConversationRoutes } from './routes/conversationRoutes.js';

const app = express();
const server = http.createServer(app);

// CORS (same behavior)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS'
  );
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// WebSocket (same permissive CORS)
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['*'], credentials: false }
});

const sessionManager = new SessionManager();

// Routes (unchanged mounts)
app.use('/api', createSessionRoutes(sessionManager, io));
app.use('/api', createChatRoutes(sessionManager, io));
app.use('/api', createContactRoutes(sessionManager, io));
// NEW: conversations index for WhatsApp-Web style UIs
app.use('/api', createConversationRoutes(sessionManager, io));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeSessions: sessionManager.getAllSessions().length,
    detectedSessions: sessionManager.detectSessions().length
  });
});

// WebSocket fan-out (kept as-is so every client receives everything)
io.on('connection', (socket) => {
  sessionManager.log('SOCKET', 'Client connected', { socketId: socket.id });

  // Initial sessions snapshot
  socket.emit('sessions_list', sessionManager.getAllSessions());

  // Forward session events to each socket (unchanged behavior)
  sessionManager.on('qr', (data) => {
    socket.emit(`qr:${data.accountId}:${data.label}`, data);
    socket.emit('qr', data);
  });

  sessionManager.on('status', (data) => {
    socket.emit(`status:${data.accountId}:${data.label}`, data);
    socket.emit('status', data);
  });

  sessionManager.on('message', (data) => {
    socket.emit(`message:${data.accountId}:${data.label}`, data);
    socket.emit('message', data);
    // chat-scoped convenience
    socket.emit(`chat_message:${data.accountId}:${data.label}:${data.message.from}`, data.message);
    socket.emit(`chat_message:${data.accountId}:${data.label}`, data.message);
  });

  sessionManager.on('session_destroyed', (data) => {
    socket.emit(`session_destroyed:${data.accountId}:${data.label}`, data);
    socket.emit('session_destroyed', data);
  });

  socket.on('disconnect', () => {
    sessionManager.log('SOCKET', 'Client disconnected', { socketId: socket.id });
  });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    server.listen(PORT, async () => {
      sessionManager.log('SYSTEM', `Server running on port ${PORT}`);
      sessionManager.log('SYSTEM', 'CORS enabled for all origins');

      const detected = sessionManager.detectSessions();
      sessionManager.log('SYSTEM', `Detected ${detected.length} sessions in filesystem`, {
        sessions: detected.map(s => `${s.accountId}::${s.label}`)
      });

      // Use the built-in auto-restore (removes duplicate logic)
      await sessionManager.autoRestoreAllSessions();
    });
  } catch (error) {
    sessionManager.log('ERROR', 'Failed to start server', { error: error.message });
  }
}

startServer();

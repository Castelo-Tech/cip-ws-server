#!/usr/bin/env node
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { SessionManager } from './lib/sessions/sessionManager.js';
import { createSessionRoutes } from './routes/sessionRoutes.js';
import { createChatRoutes } from './routes/chatRoutes.js';


const app = express();
const server = http.createServer(app);

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.use(express.json());

// Socket.IO with CORS enabled
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: false
  }
});

// Initialize session manager
const sessionManager = new SessionManager();

// Setup routes with io instance
const sessionRoutes = createSessionRoutes(sessionManager, io);
app.use('/api', sessionRoutes);

const chatRoutes = createChatRoutes(sessionManager, io);
app.use('/api', chatRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeSessions: sessionManager.getAllSessions().length,
    detectedSessions: sessionManager.detectSessions().length
  });
});

io.on('connection', (socket) => {
  sessionManager.log('SOCKET', 'Client connected', { socketId: socket.id });
  
  // Send current sessions
  socket.emit('sessions_list', sessionManager.getAllSessions());
  
  // Forward ALL session manager events to socket with specific channels
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
    
    // Also emit chat-specific events
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

// Auto-restore all sessions when server starts
async function startServer() {
  try {
    // First start the server
    server.listen(PORT, () => {
      sessionManager.log('SYSTEM', `Server running on port ${PORT}`);
      sessionManager.log('SYSTEM', 'CORS enabled for all origins');
      
      // Then restore all detected sessions
      const detected = sessionManager.detectSessions();
      sessionManager.log('SYSTEM', `Detected ${detected.length} sessions in filesystem`, {
        sessions: detected.map(s => `${s.accountId}::${s.label}`)
      });
      
      if (detected.length > 0) {
        sessionManager.log('SYSTEM', 'Auto-restoring all detected sessions...');
        detected.forEach(async (session) => {
          try {
            await sessionManager.initSession(session.accountId, session.label);
            sessionManager.log('SYSTEM', `Auto-restored session: ${session.accountId}::${session.label}`);
          } catch (error) {
            sessionManager.log('ERROR', `Failed to auto-restore session: ${session.accountId}::${session.label}`, {
              error: error.message
            });
          }
        });
      }
    });
  } catch (error) {
    sessionManager.log('ERROR', 'Failed to start server', { error: error.message });
  }
}

startServer();
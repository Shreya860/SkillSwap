require('dotenv').config();
const express  = require('express');
const http     = require('http');
const path     = require('path');
const { Server } = require('socket.io');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const Database = require('better-sqlite3');  // npm install better-sqlite3

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

/* ═══════════════════════════════════════════
   SQLite DATABASE SETUP
   • File: backend/skillswap.db
   • Auto-created on first run
═══════════════════════════════════════════ */
const db = new Database(path.join(__dirname, 'skillswap.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL,
    email    TEXT    NOT NULL UNIQUE,
    password TEXT    NOT NULL,
    created_at TEXT  DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user   TEXT    NOT NULL,
    to_user     TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair
    ON messages(from_user, to_user);
`);

// Prepared statements for speed
const insertUser    = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)');
const findByEmail   = db.prepare('SELECT * FROM users WHERE email = ?');
const insertMessage = db.prepare('INSERT INTO messages (from_user, to_user, text) VALUES (?, ?, ?)');
const getMessages   = db.prepare(`
  SELECT * FROM messages
  WHERE (from_user = ? AND to_user = ?)
     OR (from_user = ? AND to_user = ?)
  ORDER BY created_at ASC
`);

/* ═══════════════════════════════════════════
   MIDDLEWARE
═══════════════════════════════════════════ */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Serve frontend files (adjust path if needed)
app.use(express.static(path.join(__dirname, '../frontend')));

/* ═══════════════════════════════════════════
   AUTH ROUTES
═══════════════════════════════════════════ */
app.post('/api/signup', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'All fields are required' });

  try {
    const result = insertUser.run(name, email, password);
    res.status(201).json({
      message: 'User created successfully',
      user: { id: result.lastInsertRowid, name, email }
    });
  } catch (err) {
    if (err.message.includes('UNIQUE'))
      return res.status(400).json({ error: 'User already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = findByEmail.get(email);
  if (!user || user.password !== password)
    return res.status(401).json({ error: 'Invalid credentials' });

  res.json({
    message: 'Login successful',
    user: { id: user.id, name: user.name, email: user.email }
  });
});

/* ═══════════════════════════════════════════
   CHAT REST API
   GET  /api/messages/:userId1/:userId2  → fetch history
   POST /api/messages                    → save a message
═══════════════════════════════════════════ */
app.get('/api/messages/:from/:to', (req, res) => {
  const { from, to } = req.params;
  const msgs = getMessages.all(from, to, to, from);
  res.json(msgs);
});

app.post('/api/messages', (req, res) => {
  const { from_user, to_user, text } = req.body;
  if (!from_user || !to_user || !text)
    return res.status(400).json({ error: 'from_user, to_user and text are required' });

  const result = insertMessage.run(from_user, to_user, text);
  res.status(201).json({ id: result.lastInsertRowid, from_user, to_user, text });
});

/* ═══════════════════════════════════════════
   SOCKET.IO — REAL-TIME CHAT
═══════════════════════════════════════════ */

// Map userId → socket.id for routing messages
const onlineUsers = new Map();   // { userId: socket.id }

io.on('connection', (socket) => {
  console.log('🔌  Socket connected:', socket.id);

  /* 1. User joins – registers their ID */
  socket.on('join', ({ userId }) => {
    onlineUsers.set(userId, socket.id);
    socket.userId = userId;
    console.log(`👤  User ${userId} joined`);
  });

  /* 2. Send a message */
  socket.on('send_message', ({ toUserId, fromUserId, text, time }) => {
    // Persist to DB
    try {
      insertMessage.run(fromUserId, String(toUserId), text);
    } catch (e) {
      console.error('DB insert error:', e.message);
    }

    // Forward to recipient if online
    const recipientSocket = onlineUsers.get(String(toUserId));
    if (recipientSocket) {
      io.to(recipientSocket).emit('receive_message', {
        fromUserId,
        text,
        time: time || new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })
      });
    }
  });

  /* 3. Typing indicators */
  socket.on('typing', ({ toUserId, fromUserId }) => {
    const recipientSocket = onlineUsers.get(String(toUserId));
    if (recipientSocket)
      io.to(recipientSocket).emit('user_typing', { fromUserId });
  });

  socket.on('stop_typing', ({ toUserId, fromUserId }) => {
    const recipientSocket = onlineUsers.get(String(toUserId));
    if (recipientSocket)
      io.to(recipientSocket).emit('user_stop_typing', { fromUserId });
  });

  /* 4. Disconnect */
  socket.on('disconnect', () => {
    if (socket.userId) onlineUsers.delete(socket.userId);
    console.log('❌  Socket disconnected:', socket.id);
  });
});

/* ═══════════════════════════════════════════
   START SERVER
═══════════════════════════════════════════ */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n🚀  SkillSwap backend running on http://localhost:${PORT}`);
  console.log(`💾  Database: ${path.join(__dirname, 'skillswap.db')}\n`);
});
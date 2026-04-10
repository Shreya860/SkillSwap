require('dotenv').config();
const express  = require('express');
const http     = require('http');
const path     = require('path');
const { Server } = require('socket.io');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const Database = require('better-sqlite3');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌  JWT_SECRET is not set in .env — refusing to start.');
  process.exit(1);
}

/* ═══════════════════════════════════════════
   SQLite DATABASE SETUP
═══════════════════════════════════════════ */
const db = new Database(path.join(__dirname, 'skillswap.db'));
db.pragma('journal_mode = WAL');   // better concurrent performance
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    email            TEXT    NOT NULL UNIQUE,
    password_hash    TEXT    NOT NULL,
    bio              TEXT    DEFAULT '',
    role             TEXT    DEFAULT '',
    availability     TEXT    DEFAULT '',
    avatar_seed      TEXT    DEFAULT '',
    skills_teaching  TEXT    DEFAULT '[]',
    skills_learning  TEXT    DEFAULT '[]',
    public_key       TEXT    DEFAULT NULL,
    created_at       TEXT    DEFAULT (datetime('now'))
  );

  -- Messages store ENCRYPTED ciphertext only (E2E — server cannot read them)
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user   INTEGER NOT NULL REFERENCES users(id),
    to_user     INTEGER NOT NULL REFERENCES users(id),
    ciphertext  TEXT    NOT NULL,
    iv          TEXT    NOT NULL,
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_user, to_user);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
`);

/* ── Prepared statements ── */
const stmt = {
  insertUser:      db.prepare(`INSERT INTO users (name, email, password_hash, avatar_seed) VALUES (?, ?, ?, ?)`),
  findByEmail:     db.prepare(`SELECT * FROM users WHERE email = ?`),
  findById:        db.prepare(`SELECT id, name, email, bio, role, availability, avatar_seed, skills_teaching, skills_learning, public_key FROM users WHERE id = ?`),
  allUsers:        db.prepare(`SELECT id, name, bio, role, availability, avatar_seed, skills_teaching, skills_learning FROM users`),
  updatePublicKey: db.prepare(`UPDATE users SET public_key = ? WHERE id = ?`),
  insertMessage:   db.prepare(`INSERT INTO messages (from_user, to_user, ciphertext, iv) VALUES (?, ?, ?, ?)`),
  getMessages:     db.prepare(`
    SELECT id, from_user, to_user, ciphertext, iv, created_at
    FROM messages
    WHERE (from_user = ? AND to_user = ?)
       OR (from_user = ? AND to_user = ?)
    ORDER BY created_at ASC
  `),
};

/* ═══════════════════════════════════════════
   MIDDLEWARE
═══════════════════════════════════════════ */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

/* ── JWT auth middleware ── */
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });

  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/* ═══════════════════════════════════════════
   AUTH ROUTES
═══════════════════════════════════════════ */
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const seed = email.split('@')[0];
    const result = stmt.insertUser.run(name, email, hash, seed);
    const payload = { id: result.lastInsertRowid, name, email };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: 'Account created', token, user: payload });
  } catch (err) {
    if (err.message.includes('UNIQUE'))
      return res.status(400).json({ error: 'Email already registered' });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const user = stmt.findByEmail.get(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const payload = { id: user.id, name: user.name, email: user.email };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  res.json({ message: 'Login successful', token, user: payload });
});

/* ═══════════════════════════════════════════
   USER ROUTES  (auth required)
═══════════════════════════════════════════ */

/* List all users (for Discover / sidebar) */
app.get('/api/users', authenticate, (req, res) => {
  const users = stmt.allUsers.all().map(u => ({
    ...u,
    skills_teaching: JSON.parse(u.skills_teaching || '[]'),
    skills_learning: JSON.parse(u.skills_learning || '[]'),
  }));
  res.json(users);
});

/* Get a single user's public profile */
app.get('/api/users/:id', authenticate, (req, res) => {
  const user = stmt.findById.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    ...user,
    skills_teaching: JSON.parse(user.skills_teaching || '[]'),
    skills_learning: JSON.parse(user.skills_learning || '[]'),
    // Never expose public_key in the general profile endpoint
    public_key: undefined,
  });
});

/* Upload caller's ECDH public key (called once after key generation) */
app.post('/api/users/me/public-key', authenticate, (req, res) => {
  const { publicKey } = req.body;
  if (!publicKey || typeof publicKey !== 'object')
    return res.status(400).json({ error: 'publicKey (JWK object) is required' });
  stmt.updatePublicKey.run(JSON.stringify(publicKey), req.user.id);
  res.json({ message: 'Public key stored' });
});

/* Fetch another user's ECDH public key (needed for key agreement) */
app.get('/api/users/:id/public-key', authenticate, (req, res) => {
  const user = stmt.findById.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.public_key) return res.status(404).json({ error: 'This user has not registered a public key yet' });
  res.json({ publicKey: JSON.parse(user.public_key) });
});

/* ═══════════════════════════════════════════
   MESSAGE ROUTES  (auth required)
   Messages are stored as AES-GCM ciphertext.
   The server CANNOT read message content.
═══════════════════════════════════════════ */
app.get('/api/messages/:toId', authenticate, (req, res) => {
  const msgs = stmt.getMessages.all(
    req.user.id, req.params.toId,
    req.params.toId, req.user.id
  );
  res.json(msgs);
});

app.post('/api/messages', authenticate, (req, res) => {
  const { to_user, ciphertext, iv } = req.body;
  if (!to_user || !ciphertext || !iv)
    return res.status(400).json({ error: 'to_user, ciphertext, and iv are required' });

  const result = stmt.insertMessage.run(req.user.id, to_user, ciphertext, iv);
  res.status(201).json({ id: result.lastInsertRowid, from_user: req.user.id, to_user, ciphertext, iv });
});

/* ═══════════════════════════════════════════
   SOCKET.IO — REAL-TIME CHAT
   Auth: JWT passed in handshake.auth.token
═══════════════════════════════════════════ */
const onlineUsers = new Map();   // userId (string) → socket.id

/* Authenticate every socket connection */
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const uid = String(socket.user.id);
  onlineUsers.set(uid, socket.id);
  console.log(`🔌  ${socket.user.name} connected (socket ${socket.id})`);

  /* Relay encrypted message to recipient — server never decrypts */
  socket.on('send_message', ({ toUserId, ciphertext, iv, time }) => {
    try {
      stmt.insertMessage.run(socket.user.id, String(toUserId), ciphertext, iv);
    } catch (e) {
      console.error('DB insert error:', e.message);
    }

    const recipientSocket = onlineUsers.get(String(toUserId));
    if (recipientSocket) {
      io.to(recipientSocket).emit('receive_message', {
        fromUserId: socket.user.id,
        ciphertext,
        iv,
        time: time || new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      });
    }
  });

  socket.on('typing', ({ toUserId }) => {
    const s = onlineUsers.get(String(toUserId));
    if (s) io.to(s).emit('user_typing', { fromUserId: socket.user.id });
  });

  socket.on('stop_typing', ({ toUserId }) => {
    const s = onlineUsers.get(String(toUserId));
    if (s) io.to(s).emit('user_stop_typing', { fromUserId: socket.user.id });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(uid);
    console.log(`❌  ${socket.user.name} disconnected`);
  });
});

/* ═══════════════════════════════════════════
   START
═══════════════════════════════════════════ */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n🚀  SkillSwap backend → http://localhost:${PORT}`);
  console.log(`💾  Database: ${path.join(__dirname, 'skillswap.db')}\n`);
});
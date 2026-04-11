# SkillSwap

SkillSwap is a peer-to-peer skill exchange platform where users trade skills instead of money. Teach what you know, learn what you love — no payments, no middleman.

---

## Features

- Skill-for-skill exchange (no money involved)
- User profiles with offered & requested skills
- Smart skill matching & discovery
- **Real-time encrypted chat** via Socket.IO
- **End-to-end encryption** on all messages (ECDH + AES-GCM)
- **JWT-based authentication** (secure login/signup)
- **SQLite database** (zero-config, file-based persistence)

---

## Tech Stack

### Frontend
- HTML, CSS, JavaScript (vanilla)
- Tailwind CSS (CDN)
- Socket.IO client
- Web Crypto API (built into all modern browsers — no library needed)

### Backend
- Node.js + Express.js
- Socket.IO (real-time messaging)
- better-sqlite3 (SQLite)
- bcryptjs (password hashing)
- jsonwebtoken (JWT auth)
- helmet, cors, morgan

### Tools
- Git & GitHub
- VS Code

---

## Project Structure

```
SkillSwap/
├── backend/
│   ├── index.js          # Express + Socket.IO + SQLite server
│   ├── package.json
│   ├── .env              # Environment variables (never commit this)
│   └── skillswap.db      # SQLite database (auto-created on first run)
├── frontend/
│   ├── auth.js           # Frontend auth helper (JWT storage + apiFetch)
│   ├── crypto.js         # E2E encryption module (ECDH + AES-GCM)
│   ├── gradient-theme.css
│   ├── splash.html
│   ├── index.html
│   ├── login.html
│   ├── signup.html
│   ├── discover.html
│   ├── profile.html
│   └── chat.html
├── fonts/
│   ├── BlueSakura.ttf
│   └── BlueSakura.otf
├── .gitignore
└── README.md
```

---

## Setup Instructions

### 1. Clone the repository

```bash
git clone https://github.com/mercer6969/SkillSwap.git
cd SkillSwap
```

### 2. Configure environment variables

Create a `.env` file inside `backend/`:

```env
PORT=5000
JWT_SECRET=your_long_random_secret_here
```

> **Generate a strong secret:**
> ```bash
> node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
> ```
> The server will refuse to start if `JWT_SECRET` is not set.

### 3. Install backend dependencies

```bash
cd backend
npm install
```

### 4. Start the backend

```bash
npm start          # production
npm run dev        # development (auto-restarts with nodemon)
```

The backend runs at `http://localhost:5000` and automatically creates `skillswap.db` on first run.

### 5. Open the frontend

Open `frontend/splash.html` in your browser, **or** visit `http://localhost:5000` — the backend serves the frontend folder statically.

---

## How End-to-End Encryption Works

SkillSwap uses the **Web Crypto API** (built into all modern browsers). No third-party crypto library is needed.

```
Signup / Login
  └── Browser generates an ECDH P-256 key pair
        ├── Private key  → stored in IndexedDB (never leaves your device)
        └── Public key   → uploaded to the server once

Opening a chat
  └── Fetch peer's public key from server
        └── Derive a shared AES-256-GCM key via ECDH
              (both sides derive the same key independently)

Sending a message
  └── Encrypt plaintext in the browser → send { ciphertext, iv } to server

Server stores
  └── Only encrypted blobs — cannot read any message content

Receiving a message
  └── Decrypt in the browser using the derived shared key
```

The server is a **zero-knowledge relay** — it routes and stores encrypted blobs only.

---

## API Reference

All routes marked  require a `Authorization: Bearer <token>` header.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/signup` | — | Register a new user |
| POST | `/api/login` | — | Login, returns JWT |
| GET | `/api/users` | | List all users (for Discover) |
| GET | `/api/users/:id` |  | Get a user's public profile |
| POST | `/api/users/me/public-key` |  | Upload your ECDH public key |
| GET | `/api/users/:id/public-key` |  | Get a peer's ECDH public key |
| GET | `/api/messages/:toId` | | Fetch encrypted message history |
| POST | `/api/messages` | Save an encrypted message |

### Socket.IO Events

Authentication: pass your JWT in the handshake — `io({ auth: { token } })`.

| Event (emit) | Payload | Description |
|---|---|---|
| `send_message` | `{ toUserId, ciphertext, iv, time }` | Send encrypted message |
| `typing` | `{ toUserId }` | Start typing indicator |
| `stop_typing` | `{ toUserId }` | Stop typing indicator |

| Event (listen) | Payload | Description |
|---|---|---|
| `receive_message` | `{ fromUserId, ciphertext, iv, time }` | Incoming encrypted message |
| `user_typing` | `{ fromUserId }` | Peer started typing |
| `user_stop_typing` | `{ fromUserId }` | Peer stopped typing |

---

## Database Schema

```sql
-- Users table
CREATE TABLE users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  email            TEXT    NOT NULL UNIQUE,
  password_hash    TEXT    NOT NULL,       -- bcrypt, never plaintext
  bio              TEXT    DEFAULT '',
  role             TEXT    DEFAULT '',
  availability     TEXT    DEFAULT '',
  avatar_seed      TEXT    DEFAULT '',
  skills_teaching  TEXT    DEFAULT '[]',   -- JSON array
  skills_learning  TEXT    DEFAULT '[]',   -- JSON array
  public_key       TEXT    DEFAULT NULL,   -- ECDH JWK (public only)
  created_at       TEXT    DEFAULT (datetime('now'))
);

-- Messages table (server stores encrypted blobs only)
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user   INTEGER NOT NULL REFERENCES users(id),
  to_user     INTEGER NOT NULL REFERENCES users(id),
  ciphertext  TEXT    NOT NULL,   -- AES-GCM encrypted, base64
  iv          TEXT    NOT NULL,   -- 12-byte IV, base64
  created_at  TEXT    DEFAULT (datetime('now'))
);
```

---

## Security Notes

| What | How |
|------|-----|
| Passwords | Hashed with `bcryptjs` (12 salt rounds) — never stored in plaintext |
| Sessions | Signed JWTs (7-day expiry) — no server-side session storage |
| Messages | AES-256-GCM encrypted client-side — server cannot read content |
| Private keys | Stored in browser IndexedDB only — never transmitted |
| Socket auth | JWT verified on every socket connection — identity cannot be spoofed |
| HTTP security | `helmet` middleware sets secure response headers |

> **Note on key portability:** Because private keys are stored in IndexedDB on a per-device basis, users who log in on a new device will generate a new key pair. Messages sent before the new key was registered cannot be decrypted on the new device. This is expected behavior for E2E encryption without a key backup scheme.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `5000`) |
| `JWT_SECRET` | **Yes** | Secret for signing JWTs — must be long and random |

---

## Future Enhancements

- Profile editing & skill management UI
-  Video-based skill sessions
-  Ratings & reviews system
-  AI-based skill recommendations
-  Key backup / multi-device support
-  Progressive Web App (PWA)

---

## Contributing

Contributions are welcome!

1. Fork the repository
2. Create a new branch (`feature/your-feature`)
3. Commit your changes
4. Open a Pull Request

---

## License

This project is licensed under the MIT License.

---

## Author

**Avneesh**
GitHub: [https://github.com/mercer6969](https://github.com/mercer6969)

---

⭐ If you find this project useful, consider giving it a star!

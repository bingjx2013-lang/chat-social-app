'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const isProduction = process.env.NODE_ENV === 'production';
const AUTH_SECRET = process.env.AUTH_SECRET;
if (isProduction && (!AUTH_SECRET || AUTH_SECRET.length < 32 || AUTH_SECRET.startsWith('replace-with-'))) {
  throw new Error('Set AUTH_SECRET to a random value of at least 32 characters before production deployment.');
}
const secret = AUTH_SECRET || 'local-development-only-secret-change-before-deployment';
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(from_user <> to_user)
  );
  CREATE INDEX IF NOT EXISTS idx_friend_requests_to_status ON friend_requests(to_user, status);
  CREATE INDEX IF NOT EXISTS idx_friend_requests_from_status ON friend_requests(from_user, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_request ON friend_requests(from_user, to_user) WHERE status = 'pending';
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    stored_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    attachment_id TEXT REFERENCES uploads(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_pair_time ON messages(sender_id, receiver_id, id);
`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
app.disable('x-powered-by');
app.set('trust proxy', isProduction ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'blob:', 'data:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: '尝试次数过多，请 15 分钟后再试。' } });
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: '上传次数过多，请稍后再试。' } });

function signToken(user) {
  return jwt.sign({ sub: String(user.id), username: user.username }, secret, { expiresIn: '7d', issuer: 'chat-social-app' });
}
function authFromHeader(req) {
  const raw = req.headers.authorization || '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    const payload = jwt.verify(match[1], secret, { issuer: 'chat-social-app' });
    const id = Number(payload.sub);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    return user || null;
  } catch { return null; }
}
function requireAuth(req, res, next) {
  const user = authFromHeader(req);
  if (!user) return res.status(401).json({ error: '登录状态已失效，请重新登录。' });
  req.user = user;
  next();
}
function areFriends(a, b) {
  return !!db.prepare(`SELECT 1 FROM friend_requests WHERE status = 'accepted' AND
    ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) LIMIT 1`).get(a, b, b, a);
}
function userRoom(id) { return `user:${id}`; }
function safeMessage(row) {
  return {
    id: row.id,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    content: row.content,
    createdAt: row.created_at,
    attachment: row.attachment_id ? {
      id: row.attachment_id,
      name: row.original_name,
      mimeType: row.mime_type,
      size: row.size
    } : null
  };
}
function messageById(id) {
  return db.prepare(`SELECT m.*, u.id AS upload_id, u.original_name, u.mime_type, u.size
    FROM messages m LEFT JOIN uploads u ON u.id = m.attachment_id WHERE m.id = ?`).get(id);
}
function errorText(err, fallback = '服务器暂时无法处理请求。') {
  if (err && typeof err.message === 'string' && err.message.length < 180) return err.message;
  return fallback;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'chat-social-app' }));
app.get('/api/config', requireAuth, (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  // Coturn REST API mode: issue short-lived per-user TURN credentials instead of exposing a shared secret.
  if (process.env.TURN_URLS && process.env.TURN_SHARED_SECRET) {
    const expiry = Math.floor(Date.now() / 1000) + 60 * 60;
    const username = `${expiry}:${req.user.id}`;
    const credential = crypto.createHmac('sha1', process.env.TURN_SHARED_SECRET).update(username).digest('base64');
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map(v => v.trim()).filter(Boolean),
      username,
      credential
    });
  }
  res.json({ iceServers });
});

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
    return res.status(400).json({ error: '账号需为 3–20 位，只能包含英文字母、数字、下划线和短横线。' });
  }
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).json({ error: '密码长度需为 8–72 字节。' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users(username, password_hash) VALUES(?, ?)').run(username, hash);
    const user = { id: Number(result.lastInsertRowid), username };
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    if (String(err.code).includes('SQLITE_CONSTRAINT')) return res.status(409).json({ error: '这个账号已经被注册了。' });
    console.error('register error:', err);
    res.status(500).json({ error: '注册失败，请稍后重试。' });
  }
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE').get(username);
  const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!ok) return res.status(401).json({ error: '账号或密码不正确。' });
  res.json({ token: signToken(user), user: { id: user.id, username: user.username } });
});
app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));

app.get('/api/users/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().replace(/[\\%_]/g, '');
  if (q.length < 2) return res.json({ users: [] });
  const rows = db.prepare(`SELECT u.id, u.username,
    EXISTS(SELECT 1 FROM friend_requests f WHERE f.status='accepted' AND
      ((f.from_user=? AND f.to_user=u.id) OR (f.from_user=u.id AND f.to_user=?))) AS isFriend,
    EXISTS(SELECT 1 FROM friend_requests f WHERE f.status='pending' AND f.from_user=? AND f.to_user=u.id) AS outgoingPending,
    EXISTS(SELECT 1 FROM friend_requests f WHERE f.status='pending' AND f.from_user=u.id AND f.to_user=?) AS incomingPending
    FROM users u WHERE u.id <> ? AND u.username LIKE ? COLLATE NOCASE ORDER BY u.username LIMIT 25`)
    .all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, `%${q}%`);
  res.json({ users: rows.map(r => ({ id: r.id, username: r.username, isFriend: !!r.isFriend,
    outgoingPending: !!r.outgoingPending, incomingPending: !!r.incomingPending })) });
});
app.post('/api/friends/request', requireAuth, (req, res) => {
  const targetId = Number(req.body?.userId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0 || targetId === req.user.id) return res.status(400).json({ error: '好友账号无效。' });
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(targetId)) return res.status(404).json({ error: '没有找到这个用户。' });
  if (areFriends(req.user.id, targetId)) return res.status(409).json({ error: '你们已经是好友了。' });
  const incoming = db.prepare("SELECT id FROM friend_requests WHERE from_user=? AND to_user=? AND status='pending' ORDER BY id DESC LIMIT 1").get(targetId, req.user.id);
  if (incoming) {
    db.prepare("UPDATE friend_requests SET status='accepted', updated_at=datetime('now') WHERE id=?").run(incoming.id);
    return res.json({ ok: true, acceptedIncoming: true, message: '已自动接受对方的好友申请。' });
  }
  const outgoing = db.prepare('SELECT id, status FROM friend_requests WHERE from_user=? AND to_user=? ORDER BY id DESC LIMIT 1').get(req.user.id, targetId);
  if (outgoing?.status === 'pending') return res.status(409).json({ error: '好友申请已经发送，请等待对方确认。' });
  if (outgoing) db.prepare("UPDATE friend_requests SET status='pending', created_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(outgoing.id);
  else db.prepare('INSERT INTO friend_requests(from_user, to_user) VALUES(?, ?)').run(req.user.id, targetId);
  res.json({ ok: true, message: '好友申请已发送。' });
});
app.get('/api/friends/requests', requireAuth, (req, res) => {
  const incoming = db.prepare(`SELECT f.id, f.from_user AS userId, u.username, f.created_at AS createdAt
    FROM friend_requests f JOIN users u ON u.id=f.from_user
    WHERE f.to_user=? AND f.status='pending' ORDER BY f.id DESC`).all(req.user.id);
  res.json({ requests: incoming });
});
app.post('/api/friends/requests/:id/respond', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const accept = req.body?.accept === true;
  const request = db.prepare("SELECT * FROM friend_requests WHERE id=? AND to_user=? AND status='pending'").get(id, req.user.id);
  if (!request) return res.status(404).json({ error: '好友申请不存在或已处理。' });
  db.prepare("UPDATE friend_requests SET status=?, updated_at=datetime('now') WHERE id=?")
    .run(accept ? 'accepted' : 'rejected', id);
  res.json({ ok: true });
});
app.get('/api/friends', requireAuth, (req, res) => {
  const friends = db.prepare(`SELECT u.id, u.username FROM friend_requests f
    JOIN users u ON u.id = CASE WHEN f.from_user=? THEN f.to_user ELSE f.from_user END
    WHERE f.status='accepted' AND (f.from_user=? OR f.to_user=?) ORDER BY u.username COLLATE NOCASE`)
    .all(req.user.id, req.user.id, req.user.id);
  res.json({ friends });
});
app.get('/api/messages/:friendId', requireAuth, (req, res) => {
  const friendId = Number(req.params.friendId);
  if (!Number.isSafeInteger(friendId) || friendId <= 0 || !areFriends(req.user.id, friendId)) {
    return res.status(403).json({ error: '只能查看好友之间的聊天记录。' });
  }
  const rows = db.prepare(`SELECT m.*, u.original_name, u.mime_type, u.size
    FROM messages m LEFT JOIN uploads u ON u.id=m.attachment_id
    WHERE (m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?)
    ORDER BY m.id DESC LIMIT 100`).all(req.user.id, friendId, friendId, req.user.id).reverse();
  res.json({ messages: rows.map(safeMessage) });
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 3, fieldNestingDepth: 2 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const blocked = new Set(['.exe', '.dll', '.bat', '.cmd', '.com', '.msi', '.sh', '.ps1', '.apk', '.jar', '.scr', '.vbs']);
    if (blocked.has(ext)) return cb(new Error('出于安全考虑，不支持发送可执行文件。'));
    cb(null, true);
  }
});
app.post('/api/upload', requireAuth, uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ error: '请选择要上传的文件。' });
    const receiverId = Number(req.body?.receiverId);
    if (!Number.isSafeInteger(receiverId) || receiverId <= 0 || !areFriends(req.user.id, receiverId)) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(403).json({ error: '只能向好友发送文件。' });
    }
    const id = crypto.randomUUID();
    const originalName = path.basename(String(req.file.originalname || 'file')).slice(0, 240) || 'file';
    const mimeType = String(req.file.mimetype || 'application/octet-stream').slice(0, 120);
    db.prepare(`INSERT INTO uploads(id, stored_name, original_name, mime_type, size, uploaded_by, receiver_id)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(id, req.file.filename, originalName, mimeType, req.file.size, req.user.id, receiverId);
    res.status(201).json({ attachment: { id, name: originalName, mimeType, size: req.file.size } });
  });
});
app.get('/api/files/:id', requireAuth, (req, res) => {
  const file = db.prepare('SELECT * FROM uploads WHERE id=?').get(String(req.params.id));
  if (!file) return res.status(404).json({ error: '文件不存在。' });
  const userAllowed = file.uploaded_by === req.user.id || file.receiver_id === req.user.id;
  if (!userAllowed || !areFriends(file.uploaded_by, file.receiver_id)) return res.status(403).json({ error: '没有权限查看这个文件。' });
  const fullPath = path.join(UPLOAD_DIR, path.basename(file.stored_name));
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '文件已丢失，请联系管理员。' });
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(fullPath);
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件不能超过 50 MB。' : '文件上传失败，请检查文件大小后重试。';
    return res.status(400).json({ error: msg });
  }
  if (err) {
    if (err.message === '出于安全考虑，不支持发送可执行文件。') return res.status(400).json({ error: err.message });
    console.error('request error:', err);
  }
  res.status(500).json({ error: errorText(err) });
});

// Each socket is authenticated independently; clients cannot choose their own sender ID.
io.use((socket, next) => {
  try {
    const raw = socket.handshake.auth?.token;
    if (!raw) return next(new Error('请先登录。'));
    const payload = jwt.verify(raw, secret, { issuer: 'chat-social-app' });
    const id = Number(payload.sub);
    const user = db.prepare('SELECT id, username FROM users WHERE id=?').get(id);
    if (!user) return next(new Error('登录状态无效。'));
    socket.user = user;
    next();
  } catch { next(new Error('登录状态已失效，请重新登录。')); }
});
io.on('connection', (socket) => {
  const me = socket.user;
  socket.join(userRoom(me.id));

  socket.on('message:send', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const receiverId = Number(data?.receiverId);
      const content = String(data?.content || '').trim().slice(0, 4000);
      const attachmentId = data?.attachmentId ? String(data.attachmentId) : null;
      if (!Number.isSafeInteger(receiverId) || receiverId <= 0 || receiverId === me.id || !areFriends(me.id, receiverId)) {
        return reply({ ok: false, error: '只能向好友发送消息。' });
      }
      if (attachmentId) {
        const file = db.prepare('SELECT * FROM uploads WHERE id=?').get(attachmentId);
        if (!file || file.uploaded_by !== me.id || file.receiver_id !== receiverId) {
          return reply({ ok: false, error: '附件无效，请重新上传。' });
        }
      }
      if (!content && !attachmentId) return reply({ ok: false, error: '不能发送空消息。' });
      const insert = db.prepare('INSERT INTO messages(sender_id, receiver_id, content, attachment_id) VALUES(?, ?, ?, ?)')
        .run(me.id, receiverId, content, attachmentId);
      const row = messageById(Number(insert.lastInsertRowid));
      const message = safeMessage(row);
      io.to(userRoom(receiverId)).emit('message:new', message);
      reply({ ok: true, message });
    } catch (err) {
      console.error('message send error:', err);
      reply({ ok: false, error: '消息发送失败，请重试。' });
    }
  });

  const forwardToFriend = (eventName, outgoingName, data, ack) => {
    const to = Number(data?.to);
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!Number.isSafeInteger(to) || to <= 0 || to === me.id || !areFriends(me.id, to)) {
      return reply({ ok: false, error: '只能与好友发起通话。' });
    }
    const payload = { from: me.id };
    if (data?.sdp !== undefined) payload.sdp = data.sdp;
    if (data?.candidate !== undefined) payload.candidate = data.candidate;
    if (data?.mode !== undefined) payload.mode = data.mode === 'audio' ? 'audio' : 'video';
    io.to(userRoom(to)).emit(outgoingName, payload);
    reply({ ok: true });
  };
  socket.on('call:invite', (data, ack) => {
    const to = Number(data?.to);
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!Number.isSafeInteger(to) || to <= 0 || !areFriends(me.id, to)) return reply({ ok: false, error: '只能与好友发起通话。' });
    io.to(userRoom(to)).emit('call:incoming', { from: me.id, fromUsername: me.username, mode: data?.mode === 'audio' ? 'audio' : 'video' });
    reply({ ok: true });
  });
  socket.on('call:accept', (data, ack) => forwardToFriend('call:accept', 'call:accepted', data, ack));
  socket.on('call:reject', (data, ack) => forwardToFriend('call:reject', 'call:rejected', data, ack));
  socket.on('call:offer', (data, ack) => forwardToFriend('call:offer', 'call:offer', data, ack));
  socket.on('call:answer', (data, ack) => forwardToFriend('call:answer', 'call:answer', data, ack));
  socket.on('call:ice', (data, ack) => forwardToFriend('call:ice', 'call:ice', data, ack));
  socket.on('call:end', (data, ack) => forwardToFriend('call:end', 'call:ended', data, ack));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Chat Social App running on http://localhost:${PORT}`);
  if (!isProduction) console.log('Development mode: set a strong AUTH_SECRET before deploying publicly.');
});

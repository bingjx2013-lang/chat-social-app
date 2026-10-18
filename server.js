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
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const isProduction = process.env.NODE_ENV === 'production';
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
    username TEXT NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    email TEXT UNIQUE COLLATE NOCASE,
    email_verified_at TEXT,
    public_id TEXT,
    phone TEXT UNIQUE,
    country_region TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, expires_at);
  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_key TEXT NOT NULL,
    ip_key TEXT NOT NULL,
    attempted_at INTEGER NOT NULL,
    succeeded INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts_account_time ON login_attempts(account_key, attempted_at);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip_key, attempted_at);
  CREATE TABLE IF NOT EXISTS email_verification_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
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

// Forward-compatible additive migrations for existing SQLite databases.
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(row => row.name));
if (!userColumns.has('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
if (!userColumns.has('email_verified_at')) db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
if (!userColumns.has('public_id')) db.exec('ALTER TABLE users ADD COLUMN public_id TEXT');
if (!userColumns.has('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
if (!userColumns.has('country_region')) db.exec('ALTER TABLE users ADD COLUMN country_region TEXT');
if (!userColumns.has('avatar_url')) db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');

// Remove the legacy case-insensitive UNIQUE constraint on username while preserving user data and foreign-key targets.
const usernameUnique = db.pragma('index_list(users)').some(index => {
  if (!index.unique) return false;
  const quotedName = String(index.name).replace(/"/g, '""');
  return db.pragma(`index_info("${quotedName}")`).map(column => column.name).join(',') === 'username';
});
if (usernameUnique) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE users_no_username_unique (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        email TEXT UNIQUE COLLATE NOCASE,
        email_verified_at TEXT,
        public_id TEXT,
        phone TEXT UNIQUE,
        country_region TEXT,
        avatar_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users_no_username_unique(id, username, password_hash, email, email_verified_at, public_id, phone, country_region, avatar_url, created_at)
        SELECT id, username, password_hash, email, email_verified_at, public_id, phone, country_region, avatar_url, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_no_username_unique RENAME TO users;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL;`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
db.exec(`CREATE TABLE IF NOT EXISTS pending_registrations (
  id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE, password_hash TEXT NOT NULL,
  phone TEXT NOT NULL, country_region TEXT NOT NULL, captcha_hash TEXT NOT NULL,
  captcha_expires_at INTEGER NOT NULL, app_code_hash TEXT, app_code_expires_at INTEGER,
  code_attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_registrations_created ON pending_registrations(created_at);`);
const pendingRegistrationColumns = new Set(db.prepare('PRAGMA table_info(pending_registrations)').all().map(row => row.name));
if (!pendingRegistrationColumns.has('avatar_url')) db.exec('ALTER TABLE pending_registrations ADD COLUMN avatar_url TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email IS NOT NULL');
function generatePublicId() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = String(crypto.randomInt(10000000, 100000000));
    if (!db.prepare('SELECT 1 FROM users WHERE public_id=?').get(value)) return value;
  }
  throw new Error('无法生成唯一 8 位数字微聊 ID，请重试。');
}
const backfillPublicIds = db.transaction(() => {
  const rows = db.prepare("SELECT id FROM users WHERE public_id IS NULL OR public_id = '' OR length(public_id) <> 8 OR public_id GLOB '*[^0-9]*'").all();
  const update = db.prepare('UPDATE users SET public_id=? WHERE id=?');
  for (const row of rows) update.run(generatePublicId(), row.id);
});
backfillPublicIds();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id_unique ON users(public_id)');

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

// Cookie-based authentication requires same-origin protection for state-changing API calls.
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return res.status(403).json({ error: '请求来源无法验证，请刷新页面后重试。' });
  let parsed;
  try { parsed = new URL(origin); } catch { return res.status(403).json({ error: '请求来源无效。' }); }
  const expectedOrigin = `${req.protocol}://${req.get('host')}`;
  if (parsed.origin !== expectedOrigin) return res.status(403).json({ error: '请求来源不受信任。' });
  next();
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: '尝试次数过多，请 15 分钟后再试。' } });
const registrationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: '注册请求过于频繁，请 15 分钟后再试。' } });
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: '上传次数过多，请稍后再试。' } });

const emailLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: '邮件请求过于频繁，请稍后再试。' } });
function accountKey(value) { return sha256(String(value || '').trim().toLowerCase()).slice(0, 32); }
function clientIpKey(req) { return sha256(String(req.ip || req.socket?.remoteAddress || 'unknown')).slice(0, 32); }
function loginLockStatus(account, ip) {
  const since = Math.floor(Date.now() / 1000) - 15 * 60;
  const accountFails = db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE account_key=? AND attempted_at>? AND succeeded=0').get(account, since).n;
  const ipFails = db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip_key=? AND attempted_at>? AND succeeded=0').get(ip, since).n;
  return { locked: accountFails >= 8 || ipFails >= 20, accountFails, ipFails };
}
function recordLoginAttempt(account, ip, succeeded) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO login_attempts(account_key, ip_key, attempted_at, succeeded) VALUES(?,?,?,?)')
    .run(account, ip, now, succeeded ? 1 : 0);
  db.prepare('DELETE FROM login_attempts WHERE attempted_at<?').run(now - 7 * 24 * 60 * 60);
}

const SESSION_COOKIE = 'chat_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function parseCookies(header = '') {
  const result = Object.create(null);
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { /* Ignore malformed cookies. */ }
  }
  return result;
}
function setSessionCookie(res, token) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (isProduction) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}
function clearSessionCookie(res) {
  const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isProduction) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}
function createSession(user, res) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const tokenHash = sha256(rawToken);
  db.prepare('DELETE FROM auth_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL').run(now);
  db.prepare('INSERT INTO auth_sessions(token_hash, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)')
    .run(tokenHash, user.id, now, now + SESSION_TTL_SECONDS);
  setSessionCookie(res, rawToken);
  return tokenHash;
}
async function sendVerificationEmail(userId, email) {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
  if (required.some(key => !process.env[key])) {
    throw new Error('邮箱验证已启用，但 SMTP 邮件服务尚未配置。');
  }
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO email_verification_tokens(token_hash,user_id,email,expires_at,created_at) VALUES(?,?,?,?,?)')
    .run(sha256(rawToken), userId, email, now + 30 * 60, now);
  const base = process.env.PUBLIC_BASE_URL || '';
  if (!/^https:\/\//i.test(base)) throw new Error('启用邮箱验证时，PUBLIC_BASE_URL 必须是 HTTPS 地址。');
  const link = `${base.replace(/\/$/, '')}/api/auth/email-verification/confirm?token=${encodeURIComponent(rawToken)}`;
  await transporter.sendMail({ from: process.env.EMAIL_FROM, to: email, subject: '微聊邮箱验证', text: `请在 30 分钟内打开此链接验证邮箱：\n${link}` });
}
function getSession(req) {
  const rawToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!rawToken || rawToken.length > 200) return null;
  const tokenHash = sha256(rawToken);
  const now = Math.floor(Date.now() / 1000);
  const session = db.prepare(`SELECT s.token_hash, s.user_id, u.username, u.public_id
    FROM auth_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`).get(tokenHash, now);
  return session || null;
}
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: '登录状态已失效，请重新登录。' });
  req.authSessionHash = session.token_hash;
  req.user = { id: session.user_id, username: session.username, publicId: session.public_id };
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

function cleanupPendingRegistrations() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM pending_registrations WHERE captcha_expires_at<? OR created_at<?').run(now, now - 30 * 60);
}
app.post('/api/auth/register/start', registrationLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const countryRegion = String(req.body?.countryRegion || '').trim().slice(0, 80);
  const phone = String(req.body?.phone || '').replace(/[\s()-]/g, '');
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) return res.status(400).json({ error: '账号需为 3–20 位，只能包含英文字母、数字、下划线和短横线。' });
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) return res.status(400).json({ error: '密码长度需为 8–72 字节。' });
  if (!countryRegion) return res.status(400).json({ error: '请填写国家/地区。' });
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) return res.status(400).json({ error: '手机号请使用国际格式，例如 +14155552671。' });
  if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone)) return res.status(409).json({ error: '该手机号已注册。' });
  try {
    cleanupPendingRegistrations();
    const hash = await bcrypt.hash(password, 12);
    const id = crypto.randomBytes(24).toString('base64url');
    const x = crypto.randomInt(1, 10), y = crypto.randomInt(1, 10);
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO pending_registrations(id,username,password_hash,phone,country_region,captcha_hash,captcha_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, username, hash, phone, countryRegion, sha256(String(x + y)), now + 5 * 60, now);
    res.status(201).json({ pendingId: id, captchaQuestion: `人机验证：${x} + ${y} = ?`, expiresInSeconds: 300 });
  } catch (err) {
    console.error('registration start failed:', err);
    res.status(500).json({ error: '无法开始注册，请稍后重试。' });
  }
});
app.post('/api/auth/register/captcha', registrationLimiter, (req, res) => {
  const pendingId = String(req.body?.pendingId || ''), answer = String(req.body?.answer || '').trim();
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(pendingId) || !/^\d{1,2}$/.test(answer)) return res.status(400).json({ error: '人机验证信息无效，请重新开始注册。' });
  const now = Math.floor(Date.now() / 1000);
  const pending = db.prepare('SELECT * FROM pending_registrations WHERE id=? AND captcha_expires_at>?').get(pendingId, now);
  if (!pending) return res.status(400).json({ error: '验证已过期，请重新开始注册。' });
  if (pending.app_code_hash) return res.status(409).json({ error: '验证码已生成，请直接输入验证码。' });
  if (sha256(answer) !== pending.captcha_hash) return res.status(400).json({ error: '人机验证答案不正确，请重试。' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('UPDATE pending_registrations SET app_code_hash=?, app_code_expires_at=?, code_attempts=0 WHERE id=?').run(sha256(code), now + 5 * 60, pendingId);
  res.json({ ok: true, message: '人机验证通过，请输入网页显示的应用验证码。', appCode: code, expiresInSeconds: 300 });
});
app.post('/api/auth/register/complete', registrationLimiter, (req, res) => {
  const pendingId = String(req.body?.pendingId || ''), code = String(req.body?.code || '').trim();
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(pendingId) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: '验证码格式不正确。' });
  const now = Math.floor(Date.now() / 1000);
  const pending = db.prepare('SELECT * FROM pending_registrations WHERE id=? AND app_code_expires_at>?').get(pendingId, now);
  if (!pending) return res.status(400).json({ error: '验证码已过期，请重新开始注册。' });
  if (pending.code_attempts >= 5) {
    db.prepare('DELETE FROM pending_registrations WHERE id=?').run(pendingId);
    return res.status(429).json({ error: '验证码尝试次数过多，请重新注册。' });
  }
  if (sha256(code) !== pending.app_code_hash) {
    db.prepare('UPDATE pending_registrations SET code_attempts=code_attempts+1 WHERE id=?').run(pendingId);
    return res.status(400).json({ error: '应用验证码不正确，请重新输入。' });
  }
  try {
    const tx = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(pending.phone)) throw new Error('该手机号已注册。');
      const publicId = generatePublicId();
      const result = db.prepare('INSERT INTO users(username,password_hash,public_id,phone,country_region,avatar_url) VALUES(?,?,?,?,?,?)').run(pending.username,pending.password_hash,publicId,pending.phone,pending.country_region,pending.avatar_url || null);
      db.prepare('DELETE FROM pending_registrations WHERE id=?').run(pendingId);
      return { id: Number(result.lastInsertRowid), username: pending.username, publicId, avatarUrl: pending.avatar_url || null };
    });
    const user = tx();
    createSession(user, res);
    res.status(201).json({ user });
  } catch (err) {
    if (String(err.code).includes('SQLITE_CONSTRAINT') || /已被注册/.test(err.message)) return res.status(409).json({ error: err.message || '账号或手机号已被注册。' });
    console.error('registration complete failed:', err);
    res.status(500).json({ error: '注册失败，请稍后重试。' });
  }
});
app.post('/api/auth/register', authLimiter, (_req, res) => res.status(410).json({ error: '请使用新版注册流程，完成网页人机验证和应用验证码后才能注册。' }));
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const publicId = String(req.body?.publicId || '').trim();
  const password = String(req.body?.password || '');
  const account = accountKey(publicId);
  const ip = clientIpKey(req);
  const lock = loginLockStatus(account, ip);
  const user = /^\d{8}$/.test(publicId)
    ? db.prepare('SELECT id, username, public_id, password_hash, email, email_verified_at, avatar_url FROM users WHERE public_id=?').get(publicId)
    : null;
  const dummyHash = '$2a$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
  const ok = await bcrypt.compare(password, user ? user.password_hash : dummyHash).catch(() => false);
  if (lock.locked) {
    recordLoginAttempt(account, ip, false);
    return res.status(429).json({ error: '登录尝试过多，请稍后再试。' });
  }
  if (!user || !ok) {
    recordLoginAttempt(account, ip, false);
    return res.status(401).json({ error: '微聊 ID 或密码不正确。请使用个人资料中的 8 位数字微聊 ID 登录。' });
  }
  if (process.env.REQUIRE_EMAIL_VERIFICATION === 'true' && user.email && !user.email_verified_at) {
    recordLoginAttempt(account, ip, false);
    return res.status(403).json({ error: '请先完成邮箱验证。' });
  }
  recordLoginAttempt(account, ip, true);
  createSession(user, res);
  res.json({ user: { id: user.id, username: user.username, publicId: user.public_id, avatarUrl: user.avatar_url || null } });
});
app.post('/api/auth/logout', (req, res) => {
  const rawToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (rawToken && rawToken.length <= 200) {
    const tokenHash = sha256(rawToken);
    db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
      .run(Math.floor(Date.now() / 1000), tokenHash);
    // Immediately disconnect sockets authenticated with this exact session.
    io.in(`session:${tokenHash}`).disconnectSockets(true);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});
app.get('/api/sessions', requireAuth, (req, res) => {
  const sessions = db.prepare(`SELECT token_hash, created_at, expires_at, revoked_at FROM auth_sessions
    WHERE user_id=? ORDER BY created_at DESC`).all(req.user.id).map((row, index) => ({
      id: row.token_hash, current: row.token_hash === req.authSessionHash,
      createdAt: row.created_at, expiresAt: row.expires_at, revoked: !!row.revoked_at,
      label: row.token_hash === req.authSessionHash ? '当前设备' : `登录设备 ${index + 1}`
    }));
  res.json({ sessions });
});
app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  const result = db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=? AND user_id=? AND revoked_at IS NULL')
    .run(Math.floor(Date.now() / 1000), id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: '会话不存在或已退出。' });
  io.in(`session:${id}`).disconnectSockets(true);
  if (id === req.authSessionHash) clearSessionCookie(res);
  res.json({ ok: true, current: id === req.authSessionHash });
});
app.post('/api/sessions/revoke-others', requireAuth, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare('SELECT token_hash FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL AND token_hash<>?')
    .all(req.user.id, req.authSessionHash);
  db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND token_hash<>?')
    .run(now, req.user.id, req.authSessionHash);
  for (const row of rows) io.in(`session:${row.token_hash}`).disconnectSockets(true);
  res.json({ ok: true, revoked: rows.length });
});
app.post('/api/auth/email-verification/request', requireAuth, emailLimiter, async (req, res) => {
  const user = db.prepare('SELECT id, username, email, email_verified_at FROM users WHERE id=?').get(req.user.id);
  if (!user.email) return res.status(400).json({ error: '请先绑定邮箱。' });
  if (user.email_verified_at) return res.json({ ok: true, verified: true });
  try { await sendVerificationEmail(user.id, user.email); res.json({ ok: true, message: '验证邮件已发送。' }); }
  catch (err) { console.error('email verification send failed:', err.message); res.status(503).json({ error: '邮件服务暂不可用，请稍后重试。' }); }
});
app.get('/api/auth/email-verification/confirm', (req, res) => {
  const token = String(req.query.token || '');
  if (token.length < 30 || token.length > 200) return res.status(400).send('验证链接无效。');
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT * FROM email_verification_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?').get(sha256(token), now);
  if (!row) return res.status(400).send('验证链接已失效或已使用。');
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET email=?, email_verified_at=datetime(\'now\') WHERE id=?').run(row.email, row.user_id);
    db.prepare('UPDATE email_verification_tokens SET used_at=? WHERE token_hash=?').run(now, row.token_hash);
    db.prepare('UPDATE email_verification_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL').run(now, row.user_id);
  });
  try { tx(); res.send('邮箱验证成功。你可以返回微聊登录。'); }
  catch { res.status(409).send('邮箱已被其他账号使用，请联系管理员。'); }
});
app.get('/api/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT email, email_verified_at, avatar_url FROM users WHERE id=?').get(req.user.id);
  res.json({ user: { ...req.user, email: row.email, emailVerified: !!row.email_verified_at, avatarUrl: row.avatar_url || null } });
});

app.get('/api/users/search', requireAuth, (req, res) => {
  // Search terms are bound as SQL parameters and matched with instr(), so '%' and '_' in a public ID are literal characters, not LIKE wildcards.
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (q.length < 2) return res.json({ users: [] });
  const rows = db.prepare(`SELECT u.id, u.username, u.public_id, u.avatar_url,
    EXISTS(SELECT 1 FROM friend_requests f WHERE f.status='accepted' AND
      ((f.from_user=? AND f.to_user=u.id) OR (f.from_user=u.id AND f.to_user=?))) AS isFriend,
    EXISTS(SELECT 1 FROM friend_requests f WHERE f.status='pending' AND f.from_user=? AND f.to_user=u.id) AS outgoingPending,
    EXISTS(SELECT 1 FROM friend_requests f WHERE f.status='pending' AND f.from_user=u.id AND f.to_user=?) AS incomingPending
    FROM users u WHERE u.id <> ? AND (instr(lower(u.username), lower(?)) > 0 OR instr(upper(u.public_id), upper(?)) = 1)
    ORDER BY CASE WHEN u.public_id = ? COLLATE NOCASE THEN 0 ELSE 1 END, u.username LIMIT 25`)
    .all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, q, q, q);
  res.json({ users: rows.map(r => ({ id: r.id, username: r.username, publicId: r.public_id, avatarUrl: r.avatar_url || null, isFriend: !!r.isFriend,
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
  const incoming = db.prepare(`SELECT f.id, f.from_user AS userId, u.username, u.public_id AS publicId, u.avatar_url AS avatarUrl, f.created_at AS createdAt
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
  const friends = db.prepare(`SELECT u.id, u.username, u.public_id AS publicId, u.avatar_url AS avatarUrl FROM friend_requests f
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

function detectSafeMime(filePath, claimedMime, originalName) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(16);
  let bytes = 0;
  try { bytes = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  const b = buf.subarray(0, bytes);
  const ext = path.extname(originalName || '').toLowerCase();
  const signatures = [
    { mime: 'image/png', ok: b.length >= 8 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
    { mime: 'image/jpeg', ok: b.length >= 3 && b[0]===0xff && b[1]===0xd8 && b[2]===0xff },
    { mime: 'image/gif', ok: b.length >= 6 && ['GIF87a','GIF89a'].includes(b.subarray(0,6).toString()) },
    { mime: 'video/mp4', ok: b.length >= 8 && b.subarray(4,8).toString() === 'ftyp' },
    { mime: 'application/pdf', ok: b.subarray(0,5).toString() === '%PDF-' },
    { mime: 'application/zip', ok: b.length >= 4 && b[0]===0x50 && b[1]===0x4b && [0x03,0x05,0x07].includes(b[2]) },
  ];
  const match = signatures.find(x => x.ok);
  if (match) return match.mime;
  const textLike = b.length > 0 && b.every(c => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127));
  if (textLike && ext === '.txt' && claimedMime === 'text/plain') return 'text/plain';
  return 'application/octet-stream';
}

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

const avatarUpload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 1, fieldNestingDepth: 1 },
  fileFilter: (_req, file, cb) => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(file.mimetype || '').toLowerCase())) {
      return cb(new Error('头像只支持 PNG、JPG、WEBP 或 GIF 图片。'));
    }
    cb(null, true);
  }
});
app.post('/api/auth/register/avatar', registrationLimiter, (req, res, next) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) return next(err);
    const pendingId = String(req.body?.pendingId || '');
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(pendingId) || !req.file) {
      if (req.file) fs.rm(req.file.path, { force: true }, () => {});
      return res.status(400).json({ error: '头像上传信息无效，请重新开始注册。' });
    }
    const now = Math.floor(Date.now() / 1000);
    const pending = db.prepare('SELECT id, avatar_url FROM pending_registrations WHERE id=? AND captcha_expires_at>?').get(pendingId, now);
    if (!pending) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(400).json({ error: '注册流程已过期，请重新开始。' });
    }
    const mimeType = detectSafeMime(req.file.path, req.file.mimetype, req.file.originalname);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(400).json({ error: '文件内容不是受支持的图片格式。' });
    }
    if (pending.avatar_url && pending.avatar_url.startsWith('/api/avatars/')) {
      fs.rm(path.join(UPLOAD_DIR, path.basename(pending.avatar_url)), { force: true }, () => {});
    }
    const avatarUrl = '/api/avatars/' + req.file.filename;
    db.prepare('UPDATE pending_registrations SET avatar_url=? WHERE id=?').run(avatarUrl, pendingId);
    res.status(201).json({ ok: true, avatarUrl });
  });
});
app.get('/api/avatars/:filename', requireAuth, (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^[0-9a-f-]{36}$/i.test(filename)) return res.status(404).json({ error: '头像不存在。' });
  const avatarUrl = '/api/avatars/' + filename;
  if (!db.prepare('SELECT 1 FROM users WHERE avatar_url=?').get(avatarUrl)) return res.status(404).json({ error: '头像不存在。' });
  const fullPath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '头像文件不存在。' });
  const mimeType = detectSafeMime(fullPath, '', filename);
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) return res.status(404).json({ error: '头像文件无效。' });
  res.setHeader('Content-Type', mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(fullPath);
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
    const mimeType = detectSafeMime(req.file.path, req.file.mimetype, originalName);
    const riskyExt = new Set(['.html','.htm','.svg','.js','.mjs','.css','.xml','.xhtml','.php','.exe','.dll','.bat','.cmd','.com','.msi','.sh','.ps1','.apk','.jar','.scr','.vbs']);
    if (riskyExt.has(path.extname(originalName).toLowerCase()) || (mimeType === 'application/octet-stream' && req.file.mimetype !== 'application/octet-stream')) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(400).json({ error: '文件类型无法安全确认，请发送常见图片、视频、PDF、ZIP 或 TXT 文件。' });
    }
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
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.original_name || 'file'))}`);
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

// Socket.IO authenticates against the same revocable server-side session as HTTP.
// Same-origin polling GETs may omit the Origin header. If Origin is present, validate
// it strictly; if absent, allow only Engine.IO polling with a valid same-site session
// cookie. Browser WebSocket handshakes must always provide Origin.
io.use((socket, next) => {
  try {
    const origin = String(socket.handshake.headers.origin || '').trim();
    const host = String(socket.handshake.headers.host || '').trim().toLowerCase();
    const forwardedHost = String(socket.handshake.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
    const transport = socket.conn?.transport?.name || 'unknown';
    if (!host) {
      console.warn('socket auth rejected: missing host header');
      return next(new Error('请求来源无法验证。'));
    }
    if (!origin) {
      if (transport !== 'polling') {
        console.warn('socket auth rejected: missing origin on non-polling transport', JSON.stringify({ transport }));
        return next(new Error('请求来源无法验证。'));
      }
    } else {
      let originUrl;
      try { originUrl = new URL(origin); } catch { originUrl = null; }
      const allowedHosts = new Set([host, forwardedHost].filter(Boolean));
      const allowedProtocol = originUrl && (originUrl.protocol === 'https:' || (!isProduction && originUrl.protocol === 'http:'));
      if (!originUrl || !allowedProtocol || originUrl.origin !== origin || !allowedHosts.has(originUrl.host.toLowerCase())) {
        console.warn('socket auth rejected: origin mismatch', JSON.stringify({
          origin,
          host,
          forwardedHost: forwardedHost || '(missing)',
          transport
        }));
        return next(new Error('请求来源不受信任。'));
      }
    }
    const rawToken = parseCookies(socket.handshake.headers.cookie || '')[SESSION_COOKIE];
    if (!rawToken || rawToken.length > 200) {
      console.warn('socket auth rejected: missing session cookie', JSON.stringify({ transport }));
      return next(new Error('请先登录。'));
    }
    const tokenHash = sha256(rawToken);
    const now = Math.floor(Date.now() / 1000);
    const session = db.prepare(`SELECT s.token_hash, s.user_id, u.username
      FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`).get(tokenHash, now);
    if (!session) {
      console.warn('socket auth rejected: session expired or revoked', JSON.stringify({ transport }));
      return next(new Error('登录状态已失效，请重新登录。'));
    }
    socket.user = { id: session.user_id, username: session.username };
    socket.sessionHash = tokenHash;
    next();
  } catch (err) {
    console.error('socket auth middleware error:', err?.message || 'unknown error');
    next(new Error('登录状态已失效，请重新登录。'));
  }
});
io.on('connection', (socket) => {
  const me = socket.user;
  socket.join(userRoom(me.id));
  socket.join(`session:${socket.sessionHash}`);
  // Enforce expiry/revocation even when a tab keeps its real-time connection open.
  const sessionCheck = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    const valid = db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?')
      .get(socket.sessionHash, now);
    if (!valid) socket.disconnect(true);
  }, 60_000);
  socket.on('disconnect', () => clearInterval(sessionCheck));

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
});

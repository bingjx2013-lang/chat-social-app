'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}

async function main() {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-security-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const results = [];
  const check = (name, condition, detail = '') => {
    if (!condition) throw new Error(name + ' failed' + (detail ? ': ' + detail : ''));
    results.push(name);
    console.log('PASS ' + name);
  };
  const waitReady = async () => {
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error('server exited early:\n' + output);
      try {
        const response = await fetch(base + '/api/health');
        if (response.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('server did not become ready:\n' + output);
  };
  const request = async (route, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (options.origin !== null) headers.Origin = options.origin || base;
    if (options.cookie) headers.Cookie = options.cookie;
    let body = options.body;
    if (options.json !== false && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(base + route, {
      method: options.method || 'GET', headers, body, redirect: 'manual'
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    const setCookie = response.headers.get('set-cookie');
    return { status: response.status, data, headers: response.headers,
      cookie: setCookie ? setCookie.split(';')[0] : null };
  };
  const register = async username => {
    const res = await request('/api/auth/register', {
      method: 'POST', body: { username, password: 'Test-Password-2026!' }
    });
    check('register ' + username, res.status === 201 && !!res.cookie, JSON.stringify(res.data));
    assert.match(res.data.user.publicId, /^[A-Za-z0-9_]{8}$/);
    return { username, id: res.data.user.id, publicId: res.data.user.publicId, cookie: res.cookie };
  };

  try {
    await waitReady();
    const home = await request('/');
    check('home page returns 200', home.status === 200);
    check('security headers present', home.headers.has('content-security-policy') && home.headers.has('x-content-type-options'));
    const health = await request('/api/health');
    check('health endpoint', health.status === 200 && health.data.ok === true);
    const unauth = await request('/api/me');
    check('unauthenticated profile rejected', unauth.status === 401);
    const missingOrigin = await request('/api/auth/logout', { method: 'POST', origin: null });
    check('state-changing request without Origin rejected', missingOrigin.status === 403);

    const suffix = crypto.randomBytes(3).toString('hex');
    const alice = await register('qa_' + suffix);
    const bob = await register('qb_' + suffix);
    const charlie = await register('qc_' + suffix);

    const duplicate = await request('/api/auth/register', {
      method: 'POST', body: { username: alice.username.toUpperCase(), password: 'Test-Password-2026!' }
    });
    check('case-insensitive duplicate account rejected', duplicate.status === 409);

    const me = await request('/api/me', { cookie: alice.cookie });
    check('session persists generated public ID', me.status === 200 && me.data.user.publicId === alice.publicId);

    const searched = await request('/api/users/search?q=' + encodeURIComponent(alice.publicId), { cookie: bob.cookie });
    check('public ID finds correct user', searched.status === 200 &&
      searched.data.users.some(user => user.id === alice.id && user.publicId === alice.publicId));

    const percentSearch = await request('/api/users/search?q=a%25', { cookie: bob.cookie });
    check('percent is treated literally, not as SQL wildcard', percentSearch.status === 200 && percentSearch.data.users.length === 0);
    const backslashSearch = await request('/api/users/search?q=' + encodeURIComponent('qa\\'), { cookie: bob.cookie });
    check('backslash search does not break SQL query', backslashSearch.status === 200 && backslashSearch.data.users.length === 0);
    const underscoreSearch = await request('/api/users/search?q=' + encodeURIComponent('qa_'), { cookie: bob.cookie });
    check('underscore remains a searchable literal character', underscoreSearch.status === 200 &&
      underscoreSearch.data.users.some(user => user.username === alice.username));

    const badOrigin = await request('/api/friends/request', {
      method: 'POST', origin: 'https://attacker.invalid', cookie: alice.cookie, body: { userId: bob.id }
    });
    check('cross-origin state change rejected', badOrigin.status === 403);

    const friendRequest = await request('/api/friends/request', {
      method: 'POST', cookie: alice.cookie, body: { userId: bob.id }
    });
    check('friend request created', friendRequest.status === 200 && friendRequest.data.ok === true);
    const requests = await request('/api/friends/requests', { cookie: bob.cookie });
    const incoming = requests.data.requests.find(item => item.userId === alice.id);
    check('incoming friend request visible to recipient', requests.status === 200 && !!incoming);
    const accept = await request('/api/friends/requests/' + incoming.id + '/respond', {
      method: 'POST', cookie: bob.cookie, body: { accept: true }
    });
    check('recipient can accept friend request', accept.status === 200);
    const friends = await request('/api/friends', { cookie: bob.cookie });
    check('accepted friendship visible', friends.status === 200 && friends.data.friends.some(user => user.id === alice.id));

    const form = new FormData();
    form.append('receiverId', String(bob.id));
    form.append('file', new Blob(['safe test content\n'], { type: 'text/plain' }), 'security-test.txt');
    const uploaded = await request('/api/upload', { method: 'POST', cookie: alice.cookie, body: form, json: false });
    check('safe text upload to friend succeeds', uploaded.status === 201 && !!uploaded.data.attachment?.id, JSON.stringify(uploaded.data));
    const fileId = uploaded.data.attachment.id;
    const downloaded = await request('/api/files/' + encodeURIComponent(fileId), { cookie: bob.cookie });
    check('file is downloadable by intended recipient only', downloaded.status === 200 &&
      (downloaded.headers.get('content-disposition') || '').includes('attachment'));
    const unauthorizedDownload = await request('/api/files/' + encodeURIComponent(fileId), { cookie: charlie.cookie });
    check('file download blocked for unrelated user', unauthorizedDownload.status === 403);

    const exeForm = new FormData();
    exeForm.append('receiverId', String(bob.id));
    exeForm.append('file', new Blob(['not really an executable']), 'payload.exe');
    const blockedFile = await request('/api/upload', {
      method: 'POST', cookie: alice.cookie, body: exeForm, json: false
    });
    check('executable upload rejected', blockedFile.status === 400);

    const secondLogin = await request('/api/auth/login', {
      method: 'POST', body: { username: alice.username, password: 'Test-Password-2026!' }
    });
    check('valid login succeeds', secondLogin.status === 200 && secondLogin.data.user.publicId === alice.publicId && !!secondLogin.cookie);
    const idLogin = await request('/api/auth/login', {
      method: 'POST', body: { username: alice.publicId, password: 'Test-Password-2026!' }
    });
    check('login with public ID succeeds', idLogin.status === 200 && idLogin.data.user.publicId === alice.publicId && idLogin.data.user.username === alice.username && !!idLogin.cookie);
    const wrongIdLogin = await request('/api/auth/login', {
      method: 'POST', body: { username: alice.publicId, password: 'definitely-wrong-password' }
    });
    check('wrong password rejected for public ID login', wrongIdLogin.status === 401);
    const wrongLogin = await request('/api/auth/login', {
      method: 'POST', body: { username: alice.username, password: 'definitely-wrong-password' }
    });
    check('wrong password rejected', wrongLogin.status === 401);

    const revoke = await request('/api/sessions/revoke-others', {
      method: 'POST', cookie: secondLogin.cookie, body: {}
    });
    check('other sessions can be revoked', revoke.status === 200 && revoke.data.revoked >= 1);
    const oldSession = await request('/api/me', { cookie: alice.cookie });
    check('revoked session no longer authenticates', oldSession.status === 401);
    const currentSession = await request('/api/me', { cookie: secondLogin.cookie });
    check('current session remains valid after revoke-others', currentSession.status === 200);

    const logout = await request('/api/auth/logout', { method: 'POST', cookie: secondLogin.cookie, body: {} });
    check('logout returns success', logout.status === 200 && logout.data.ok === true);
    const afterLogout = await request('/api/me', { cookie: secondLogin.cookie });
    check('logout invalidates session server-side', afterLogout.status === 401);

    let rateLimited = false;
    for (let i = 0; i < 14; i++) {
      const attempt = await request('/api/auth/login', {
        method: 'POST', body: { username: 'unknown_' + suffix, password: 'wrong-password' }
      });
      if (attempt.status === 429) { rateLimited = true; break; }
    }
    check('repeated login attempts are rate limited', rateLimited);

    console.log('\n' + results.length + ' security smoke checks passed.');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref();
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('\nFAIL ' + (error.stack || error));
  process.exitCode = 1;
});

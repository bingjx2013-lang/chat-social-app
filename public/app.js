'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  socket: null,
  friends: [],
  selectedFriend: null,
  authMode: 'login',
  incomingCall: null,
  callPeer: null,
  callMode: 'video',
  callRole: null,
  callPending: false,
  localStream: null,
  remoteStream: null,
  peerConnection: null,
  queuedIce: [],
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  attachmentUrls: new Map(),
  callEnding: false
};

let toastTimer;
function toast(message, duration = 2800) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function initial(name) { return String(name || '?').trim().charAt(0).toUpperCase() || '?'; }
function colorClass(id) { return `color-${(Math.abs(Number(id) || 0) % 4) + 1}`; }
function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function formatTime(timestamp) {
  const raw = String(timestamp || '');
  const parsed = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDay(timestamp) {
  const raw = String(timestamp || '');
  const parsed = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const hasBody = options.body !== undefined && options.body !== null;
  if (hasBody && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers });
  let body;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) body = await response.json();
  else body = await response.text();
  if (!response.ok) {
    if (response.status === 401 && state.user) logout(false, '登录已过期，请重新登录。');
    const message = body && typeof body === 'object' ? body.error : String(body || '请求失败');
    throw new Error(message || '请求失败');
  }
  return body;
}

const countryList = Array.isArray(window.MICROCHAT_COUNTRIES) ? window.MICROCHAT_COUNTRIES : [];
const regionNames = (() => { try { return new Intl.DisplayNames([navigator.language || 'zh-CN'], { type: 'region' }); } catch { return null; } })();
const countryByCode = new Map(countryList.map(item => {
  let localizedName = item.name;
  try { localizedName = regionNames && regionNames.of(item.code) || item.name; } catch {}
  if (!localizedName || localizedName === item.code) localizedName = item.name;
  const flag = String.fromCodePoint(...item.code.split('').map(ch => 127397 + ch.charCodeAt(0)));
  return [item.code, { ...item, localizedName, flag }];
}));
function initCountryPickers() {
  const countrySelect = $('countryRegion'), dialSelect = $('countryCallingCode');
  for (const item of countryByCode.values()) {
    const label = item.flag + ' ' + item.localizedName;
    const a = document.createElement('option'); a.value = item.code; a.textContent = label; countrySelect.appendChild(a);
    const b = document.createElement('option'); b.value = item.code; b.textContent = '+' + item.dial + ' — ' + item.localizedName; dialSelect.appendChild(b);
  }
  const browserRegion = (() => { try { return new Intl.Locale(navigator.language).region || ''; } catch { return ''; } })();
  const initial = countryByCode.has(browserRegion) ? browserRegion : (countryByCode.has('CN') ? 'CN' : 'US');
  countrySelect.value = initial; dialSelect.value = initial;
  countrySelect.addEventListener('change', () => { dialSelect.value = countrySelect.value; });
  dialSelect.addEventListener('change', () => { countrySelect.value = dialSelect.value; });
}
function getSelectedCountry() { return countryByCode.get($('countryRegion').value) || null; }
function composeInternationalPhone(country) {
  let national = String($('phone').value || '').replace(/\D/g, '');
  if (country.code !== 'IT') national = national.replace(/^0+/, '');
  const phone = '+' + country.dial + national;
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) throw new Error('手机号格式不正确，请检查国家区号和本地号码。');
  return phone;
}
function resetAvatarChoice() {
  $('avatarFile').value = ''; $('avatarPreview').src = ''; $('avatarPreview').classList.add('hidden'); $('avatarPreviewDefault').classList.remove('hidden');
}
function previewAvatarChoice() {
  const file = $('avatarFile').files && $('avatarFile').files[0];
  if (!file) return resetAvatarChoice();
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 2 * 1024 * 1024) {
    $('avatarFile').value = ''; resetAvatarChoice(); $('authError').textContent = '头像只支持 PNG、JPG、WEBP、GIF，且不能超过 2 MB。'; return;
  }
  $('authError').textContent = ''; $('avatarPreview').src = URL.createObjectURL(file); $('avatarPreview').classList.remove('hidden'); $('avatarPreviewDefault').classList.add('hidden');
}

function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === 'register';
  $('loginTab').classList.toggle('active', !registering);
  $('registerTab').classList.toggle('active', registering);
  $('authSubmit').textContent = registering ? '创建账号' : '登录';
  $('usernameLabel').textContent = registering ? '账号' : '账号 / 微聊 ID';
  $('username').placeholder = registering ? '输入账号名称（可重复）' : '输入用户名或 8 位数字微聊 ID';
  $('authHint').textContent = registering ? '注册需填写国家/地区和国际格式手机号。人机验证通过后，网页会显示应用验证码。' : '还没有账号？选择“注册账号”即可创建。';
  $('countryRegionLabel').hidden = !registering; $('countryRegion').hidden = !registering; $('countryRegion').required = registering;
  $('countryCallingCodeLabel').hidden = !registering; $('countryCallingCode').hidden = !registering; $('countryCallingCode').required = registering;
  $('phoneLabel').hidden = !registering; $('phone').hidden = !registering; $('phone').required = registering;
  $('avatarLabel').hidden = !registering; $('avatarFile').hidden = !registering; $('avatarChoice').hidden = !registering;
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  $('authError').textContent = '';
}
function showAuth(error = '') {
  $('authView').classList.remove('hidden');
  $('appView').classList.add('hidden');
  $('authError').textContent = error;
}
function showApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
}
let pendingRegistrationId = '', registrationAppCodeIssued = false;
async function handleAuth(event) {
  event.preventDefault(); const button = $('authSubmit'); button.disabled = true; $('authError').textContent = '';
  try {
    const username = $('username').value.trim(), password = $('password').value;
    if (state.authMode === 'register') {
      const selectedCountry = getSelectedCountry();
      if (!selectedCountry) throw new Error('请从完整国家/地区列表中选择国家。');
      const fullPhone = composeInternationalPhone(selectedCountry);
      const result = await api('/api/auth/register/start', {method:'POST',body:JSON.stringify({username,password,countryRegion:selectedCountry.localizedName,phone:fullPhone})});
      pendingRegistrationId=result.pendingId; registrationAppCodeIssued=false;
      const avatarFile = $('avatarFile').files && $('avatarFile').files[0];
      if (avatarFile) {
        const avatarForm = new FormData(); avatarForm.append('pendingId', pendingRegistrationId); avatarForm.append('avatar', avatarFile);
        await api('/api/auth/register/avatar', {method:'POST',body:avatarForm});
      }
      $('captchaQuestion').textContent=result.captchaQuestion; $('captchaAnswer').value=''; $('captchaAnswer').hidden=false;
      $('appCodeDisplay').hidden=true; $('appCodeNotice').hidden=true; $('appCodeLabel').hidden=true; $('appCodeInput').hidden=true; $('appCodeInput').value='';
      $('completeRegistrationBtn').disabled=true; $('captchaVerifyBtn').hidden=false; $('registrationVerifyError').textContent='';
      $('registrationVerifyModal').classList.remove('hidden'); $('captchaAnswer').focus(); return;
    }
    const result=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username,password})});
    state.user=result.user; $('password').value=''; await startApp();
  } catch(err) { $('authError').textContent=err.message; } finally { button.disabled=false; }
}
async function verifyRegistrationHuman() {
  if(!pendingRegistrationId)return; const button=$('captchaVerifyBtn'); button.disabled=true; $('registrationVerifyError').textContent='';
  try {
    const result=await api('/api/auth/register/captcha',{method:'POST',body:JSON.stringify({pendingId:pendingRegistrationId,answer:$('captchaAnswer').value.trim()})});
    registrationAppCodeIssued=true; $('appCodeDisplay').textContent=result.appCode; $('appCodeDisplay').hidden=false; $('appCodeNotice').hidden=false;
    $('appCodeLabel').hidden=false; $('appCodeInput').hidden=false; $('captchaAnswer').hidden=true; $('captchaVerifyBtn').hidden=true;
    $('completeRegistrationBtn').disabled=true; $('appCodeInput').focus();
  } catch(err){$('registrationVerifyError').textContent=err.message;} finally{button.disabled=false;}
}
async function completeRegistration() {
  if(!pendingRegistrationId||!registrationAppCodeIssued)return; const button=$('completeRegistrationBtn');button.disabled=true;$('registrationVerifyError').textContent='';
  try {
    const result=await api('/api/auth/register/complete',{method:'POST',body:JSON.stringify({pendingId:pendingRegistrationId,code:$('appCodeInput').value.trim()})});
    pendingRegistrationId='';registrationAppCodeIssued=false;$('registrationVerifyModal').classList.add('hidden');$('password').value='';state.user=result.user;await startApp();
  } catch(err){$('registrationVerifyError').textContent=err.message;} finally{button.disabled=false;}
}
async function startApp() {
  try {
    if (!state.user) {
      const me = await api('/api/me');
      state.user = me.user;
    }
    $('currentUsername').textContent = state.user.username;
    const ownAvatar = $('currentUserAvatar');
    if (state.user.avatarUrl) { ownAvatar.src = state.user.avatarUrl; ownAvatar.classList.remove('hidden'); }
    else { ownAvatar.removeAttribute('src'); ownAvatar.classList.add('hidden'); }
    $('myPublicId').textContent = state.user.publicId || '正在生成…';
    showApp();
    try {
      const config = await api('/api/config');
      if (Array.isArray(config.iceServers) && config.iceServers.length) state.iceServers = config.iceServers;
    } catch { /* Use default STUN server if config is unavailable. */ }
    await Promise.all([loadFriends(), loadRequests()]);
    connectSocket();
  } catch (err) {
    logout(false, err.message || '请重新登录。');
  }
}
function connectSocket() {
  if (state.socket) state.socket.disconnect();
  if (typeof io !== 'function') return toast('实时消息组件加载失败，请刷新页面。', 5000);
  state.socket = io();
  state.socket.on('connect', () => $('chatFriendStatus').textContent = state.selectedFriend ? '实时消息已连接' : '微聊联系人');
  state.socket.on('disconnect', () => {
    if (state.selectedFriend) $('chatFriendStatus').textContent = '连接中断，正在重连…';
  });
  state.socket.on('connect_error', (err) => {
    if (/登录|无效|失效/.test(err.message || '')) logout(false, '登录已过期，请重新登录。');
    else toast('实时连接暂不可用，正在尝试重连。');
  });
  state.socket.on('message:new', (message) => {
    const otherId = message.senderId === state.user.id ? message.receiverId : message.senderId;
    if (state.selectedFriend && Number(otherId) === Number(state.selectedFriend.id)) appendMessage(message);
    else toast('收到一条新消息');
    loadFriends().catch(() => {});
  });
  state.socket.on('call:incoming', onIncomingCall);
  state.socket.on('call:accepted', onCallAccepted);
  state.socket.on('call:rejected', ({ from }) => {
    if (Number(from) === Number(state.callPeer)) {
      toast('对方暂时无法接听。');
      cleanupCall(false);
    }
  });
  state.socket.on('call:offer', onCallOffer);
  state.socket.on('call:answer', onCallAnswer);
  state.socket.on('call:ice', onRemoteIce);
  state.socket.on('call:ended', ({ from }) => {
    if (Number(from) === Number(state.callPeer)) {
      toast('通话已结束。');
      cleanupCall(false);
    }
  });
}
async function loadFriends() {
  const result = await api('/api/friends');
  state.friends = result.friends || [];
  renderFriends();
  if (state.selectedFriend) {
    const updated = state.friends.find(f => Number(f.id) === Number(state.selectedFriend.id));
    if (!updated) {
      state.selectedFriend = null;
      $('chatView').classList.add('hidden');
      $('welcomePanel').classList.remove('hidden');
      document.querySelector('.workspace').classList.remove('chat-open');
    } else state.selectedFriend = updated;
  }
}
function renderFriends() {
  const list = $('friendsList');
  list.replaceChildren();
  $('friendCount').textContent = String(state.friends.length);
  $('emptyFriends').classList.toggle('hidden', state.friends.length > 0);
  state.friends.forEach((friend) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `friend-row${state.selectedFriend && Number(state.selectedFriend.id) === Number(friend.id) ? ' active' : ''}`;
    button.dataset.friendId = String(friend.id);
    const avatar = friend.avatarUrl ? document.createElement('img') : document.createElement('span');
    avatar.className = `avatar ${colorClass(friend.id)}`;
    if (friend.avatarUrl) { avatar.src = friend.avatarUrl; avatar.alt = friend.username; }
    else avatar.textContent = initial(friend.username);
    const detail = document.createElement('span');
    detail.className = 'friend-detail';
    const name = document.createElement('span');
    name.className = 'friend-name'; name.textContent = friend.username;
    const preview = document.createElement('span');
    preview.className = 'friend-preview'; preview.textContent = `微聊 ID：${friend.publicId || '—'}`;
    detail.append(name, preview);
    const status = document.createElement('span'); status.className = 'friend-status'; status.title = '联系人';
    button.append(avatar, detail, status);
    list.append(button);
  });
}
async function loadRequests() {
  const result = await api('/api/friends/requests');
  renderRequests(result.requests || []);
}
function renderRequests(requests) {
  $('requestCount').textContent = String(requests.length);
  const list = $('requestsList');
  list.replaceChildren();
  if (!requests.length) {
    const empty = document.createElement('div'); empty.className = 'search-caption'; empty.textContent = '暂时没有新的申请。'; list.append(empty); return;
  }
  requests.forEach((request) => {
    const row = document.createElement('div'); row.className = 'request-row';
    const avatar = request.avatarUrl ? document.createElement('img') : document.createElement('span'); avatar.className = `avatar ${colorClass(request.userId)}`; if (request.avatarUrl) { avatar.src = request.avatarUrl; avatar.alt = request.username; } else avatar.textContent = initial(request.username);
    const info = document.createElement('span'); info.className = 'result-info';
    const name = document.createElement('strong'); name.textContent = request.username;
    const small = document.createElement('small'); small.textContent = `微聊 ID：${request.publicId || '—'} · 申请添加你为好友`; info.append(name, small);
    const actions = document.createElement('span'); actions.className = 'request-actions';
    const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'request-accept'; accept.textContent = '接受';
    accept.addEventListener('click', async () => {
      accept.disabled = true;
      try { await api(`/api/friends/requests/${request.id}/respond`, { method: 'POST', body: JSON.stringify({ accept: true }) }); await Promise.all([loadFriends(), loadRequests()]); toast('已添加好友。'); }
      catch (e) { toast(e.message); accept.disabled = false; }
    });
    const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'request-reject'; reject.textContent = '拒绝';
    reject.addEventListener('click', async () => {
      reject.disabled = true;
      try { await api(`/api/friends/requests/${request.id}/respond`, { method: 'POST', body: JSON.stringify({ accept: false }) }); await loadRequests(); }
      catch (e) { toast(e.message); reject.disabled = false; }
    });
    actions.append(accept, reject); row.append(avatar, info, actions); list.append(row);
  });
}
async function searchUsers(event) {
  event.preventDefault();
  const query = $('searchInput').value.trim();
  if (query.length < 2) { toast('请输入至少 2 个字符再搜索。'); return; }
  const box = $('searchResults');
  box.classList.remove('hidden'); box.replaceChildren();
  const loading = document.createElement('div'); loading.className = 'search-caption'; loading.textContent = '正在搜索…'; box.append(loading);
  try {
    const result = await api(`/api/users/search?q=${encodeURIComponent(query)}`);
    box.replaceChildren();
    if (!result.users.length) {
      const empty = document.createElement('div'); empty.className = 'search-caption'; empty.textContent = '没有找到匹配账号。'; box.append(empty); return;
    }
    const caption = document.createElement('div'); caption.className = 'search-caption'; caption.textContent = `搜索结果（${result.users.length}）`; box.append(caption);
    result.users.forEach((user) => {
      const row = document.createElement('div'); row.className = 'result-row';
      const avatar = user.avatarUrl ? document.createElement('img') : document.createElement('span'); avatar.className = `avatar ${colorClass(user.id)}`; if (user.avatarUrl) { avatar.src = user.avatarUrl; avatar.alt = user.username; } else avatar.textContent = initial(user.username);
      const info = document.createElement('span'); info.className = 'result-info';
      const name = document.createElement('strong'); name.textContent = user.username;
      const small = document.createElement('small'); small.textContent = `微聊 ID：${user.publicId || '—'}`; info.append(name, small);
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'mini-action';
      if (user.isFriend) { btn.textContent = '已添加'; btn.disabled = true; }
      else if (user.outgoingPending) { btn.textContent = '已发送'; btn.disabled = true; }
      else { btn.textContent = user.incomingPending ? '确认添加' : '加好友'; btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { const result = await api('/api/friends/request', { method: 'POST', body: JSON.stringify({ userId: user.id }) }); toast(result.message || '好友申请已发送。'); await Promise.all([loadFriends(), loadRequests(), searchUsers(new Event('submit'))]); }
        catch (e) { toast(e.message); btn.disabled = false; }
      }); }
      row.append(avatar, info, btn); box.append(row);
    });
  } catch (err) {
    box.replaceChildren(); const message = document.createElement('div'); message.className = 'search-caption'; message.textContent = err.message; box.append(message);
  }
}
async function selectFriend(friendId) {
  const friend = state.friends.find(f => Number(f.id) === Number(friendId));
  if (!friend) return;
  state.selectedFriend = friend;
  renderFriends();
  $('chatFriendName').textContent = friend.username;
  $('chatAvatar').textContent = initial(friend.username);
  $('chatAvatar').className = `avatar chat-avatar ${colorClass(friend.id)}`;
  $('chatFriendStatus').textContent = '正在加载聊天记录…';
  $('welcomePanel').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  document.querySelector('.workspace').classList.add('chat-open');
  $('messageList').replaceChildren();
  const loading = document.createElement('div'); loading.className = 'chat-loading'; loading.textContent = '正在加载聊天记录…'; $('messageList').append(loading);
  try {
    const data = await api(`/api/messages/${friend.id}`);
    if (!state.selectedFriend || Number(state.selectedFriend.id) !== Number(friend.id)) return;
    renderMessages(data.messages || []);
    $('chatFriendStatus').textContent = state.socket?.connected ? '实时消息已连接' : '微聊联系人';
    $('messageInput').focus();
  } catch (err) {
    $('messageList').replaceChildren(); const e = document.createElement('div'); e.className = 'chat-empty'; e.textContent = err.message; $('messageList').append(e);
  }
}
function renderMessages(messages) {
  const list = $('messageList'); list.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('div'); empty.className = 'chat-empty'; empty.textContent = '这是你们的第一条对话，打个招呼吧。'; list.append(empty); return;
  }
  let lastDay = '';
  messages.forEach((message) => {
    const day = formatDay(message.createdAt);
    if (day && day !== lastDay) {
      const divider = document.createElement('div'); divider.className = 'date-divider'; divider.textContent = day; list.append(divider); lastDay = day;
    }
    appendMessage(message, false);
  });
  scrollMessages();
}
function appendMessage(message, scroll = true) {
  const list = $('messageList');
  if (!list || (state.selectedFriend && ![Number(message.senderId), Number(message.receiverId)].includes(Number(state.selectedFriend.id)))) return;
  if (list.querySelector(`[data-message-id="${Number(message.id)}"]`)) return;
  const empty = list.querySelector('.chat-empty'); if (empty) empty.remove();
  const mine = Number(message.senderId) === Number(state.user.id);
  const row = document.createElement('div'); row.className = `message-row${mine ? ' mine' : ''}`; row.dataset.messageId = String(message.id);
  if (!mine) {
    const avatar = document.createElement('span'); avatar.className = `avatar message-avatar ${colorClass(state.selectedFriend?.id)}`; avatar.textContent = initial(state.selectedFriend?.username); row.append(avatar);
  }
  const body = document.createElement('div'); body.className = 'message-body';
  const author = document.createElement('div'); author.className = 'message-author'; author.textContent = mine ? '我' : (state.selectedFriend?.username || '好友'); body.append(author);
  if (message.content) {
    const bubble = document.createElement('div'); bubble.className = 'message-bubble'; bubble.textContent = message.content; body.append(bubble);
  }
  if (message.attachment) {
    const holder = document.createElement('div'); holder.className = 'message-attachment';
    const loading = document.createElement('small'); loading.className = 'attachment-meta'; loading.textContent = '附件加载中…'; holder.append(loading); body.append(holder);
    loadAttachment(message.attachment).then((url) => {
      if (!holder.isConnected) return;
      holder.replaceChildren();
      const att = message.attachment;
      if (att.mimeType?.startsWith('image/')) {
        const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener';
        const img = document.createElement('img'); img.className = 'attachment-preview'; img.src = url; img.alt = att.name || '图片'; img.loading = 'lazy'; link.append(img); holder.append(link);
      } else if (att.mimeType?.startsWith('video/')) {
        const video = document.createElement('video'); video.className = 'attachment-video'; video.src = url; video.controls = true; video.preload = 'metadata'; holder.append(video);
      } else if (att.mimeType?.startsWith('audio/')) {
        const audio = document.createElement('audio'); audio.src = url; audio.controls = true; holder.append(audio);
      } else {
        const icon = document.createElement('span'); icon.className = 'attachment-file-icon'; icon.textContent = '↧';
        const meta = document.createElement('span'); meta.className = 'attachment-meta';
        const link = document.createElement('a'); link.className = 'attachment-link'; link.href = url; link.download = att.name || 'download'; link.textContent = att.name || '下载文件';
        const size = document.createElement('small'); size.textContent = formatSize(att.size); meta.append(link, size); holder.append(icon, meta);
      }
    }).catch((err) => {
      if (holder.isConnected) { holder.replaceChildren(); const text = document.createElement('small'); text.textContent = err.message || '附件无法加载'; holder.append(text); }
    });
  }
  const time = document.createElement('div'); time.className = 'message-time'; time.textContent = formatTime(message.createdAt); body.append(time);
  row.append(body); list.append(row);
  if (scroll) scrollMessages();
}
function scrollMessages() { const list = $('messageList'); if (list) list.scrollTop = list.scrollHeight; }
async function loadAttachment(attachment) {
  if (state.attachmentUrls.has(attachment.id)) return state.attachmentUrls.get(attachment.id);
  const response = await fetch(`/api/files/${encodeURIComponent(attachment.id)}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(response.status === 403 ? '没有权限查看此附件' : '附件下载失败');
  const url = URL.createObjectURL(await response.blob());
  state.attachmentUrls.set(attachment.id, url);
  return url;
}
function sendMessage(content, attachmentId = null) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) return reject(new Error('实时连接中断，请等待重新连接。'));
    if (!state.selectedFriend) return reject(new Error('请先选择一个好友。'));
    state.socket.timeout(12000).emit('message:send', {
      receiverId: state.selectedFriend.id,
      content,
      attachmentId
    }, (err, result) => {
      if (err) return reject(new Error('发送超时，请重试。'));
      if (!result?.ok) return reject(new Error(result?.error || '发送失败。'));
      resolve(result.message);
    });
  });
}
async function submitMessage(event) {
  event.preventDefault();
  const input = $('messageInput');
  const content = input.value.trim();
  if (!content) return;
  $('sendBtn').disabled = true;
  try {
    const message = await sendMessage(content);
    appendMessage(message);
    input.value = ''; input.style.height = 'auto';
  } catch (err) { toast(err.message); }
  finally { $('sendBtn').disabled = false; input.focus(); }
}
async function uploadFiles(files) {
  if (!state.selectedFriend) { toast('请先选择好友再发送附件。'); return; }
  const targetId = state.selectedFriend.id;
  for (const file of files) {
    if (!state.selectedFriend || Number(state.selectedFriend.id) !== Number(targetId)) { toast('联系人已切换，剩余文件已取消。'); return; }
    if (file.size > 50 * 1024 * 1024) { toast(`${file.name} 超过 50 MB，已跳过。`); continue; }
    toast(`正在上传：${file.name}`, 60000);
    try {
      const form = new FormData(); form.append('file', file); form.append('receiverId', String(targetId));
      const result = await api('/api/upload', { method: 'POST', body: form });
      const message = await sendMessage('', result.attachment.id);
      appendMessage(message);
    } catch (err) { toast(`${file.name}：${err.message}`, 5000); }
  }
  $('toast').classList.remove('show');
}

function onIncomingCall(call) {
  if (!call || Number(call.from) === Number(state.user.id)) return;
  if (state.callPeer || state.callPending || state.incomingCall) {
    state.socket.emit('call:reject', { to: call.from });
    return;
  }
  state.incomingCall = call;
  $('incomingTitle').textContent = call.mode === 'audio' ? '收到语音通话' : '收到视频通话';
  $('incomingText').textContent = `${call.fromUsername || '好友'} 正在呼叫你`;
  $('incomingModal').classList.remove('hidden');
}
function mediaAccessError(error, mode) {
  const name = error && error.name || '';
  const needsVideo = mode === 'video';
  const devices = needsVideo ? '麦克风和摄像头' : '麦克风';
  if (!window.isSecureContext) {
    return '当前页面不是安全的 HTTPS 环境，浏览器因此不能调用' + devices + '。请打开微聊的 HTTPS 网站后重试。';
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return devices + '权限被系统或浏览器拒绝。请在手机系统设置中允许微聊/浏览器使用' + devices +
      '，并在浏览器的网站设置中允许相应权限，然后关闭页面重新进入再试。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到可用的' + devices + '设备，请检查设备是否存在或已连接。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return devices + '暂时无法使用，可能正被其他应用占用。请关闭其他通话或相机应用后重试。';
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return '当前设备不支持所需的视频参数，请切换设备或重试。';
  }
  return '无法启用' + devices + '。请检查系统权限、浏览器网站权限，并重试。' +
    (error && error.message ? '（' + error.message + '）' : '');
}
async function startCall(friend, mode) {
  if (!state.socket?.connected) return toast('实时连接尚未就绪，请稍后重试。');
  if (!window.isSecureContext) return toast('通话需要安全的 HTTPS 页面，请打开微聊的 HTTPS 网站。', 6000);
  if (!navigator.mediaDevices?.getUserMedia) return toast('此应用/浏览器未开放音视频设备接口。请更新浏览器，或改用 Chrome 打开微聊 HTTPS 网站。', 6000);
  if (state.callPeer || state.callPending) return toast('你已经有一通进行中的电话。');
  state.callPeer = friend.id;
  state.callMode = mode;
  state.callRole = 'caller';
  state.callPending = true;
  try {
    await prepareCallUI(friend.username, mode);
    await startLocalMedia(mode);
    createPeerConnection();
    const response = await socketAck('call:invite', { to: friend.id, mode });
    if (!response.ok) throw new Error(response.error || '呼叫失败。');
    $('callStatus').textContent = '等待对方接听…';
  } catch (err) {
    toast(err && err.name ? mediaAccessError(err, mode) : (err.message || '无法发起通话。'), 6500);
    cleanupCall(false);
  }
}
function socketAck(eventName, payload) {
  return new Promise((resolve, reject) => {
    if (!state.socket?.connected) return reject(new Error('实时连接中断。'));
    state.socket.timeout(10000).emit(eventName, payload, (err, response) => {
      if (err) return reject(new Error('请求超时，请重试。'));
      resolve(response || { ok: false, error: '服务器未响应。' });
    });
  });
}
async function prepareCallUI(name, mode) {
  $('callTitle').textContent = mode === 'audio' ? '语音通话' : '视频通话';
  $('remoteCallName').textContent = name || '好友';
  $('remoteCallAvatar').textContent = initial(name);
  $('remotePlaceholder').classList.remove('hidden');
  $('remoteVideo').classList.toggle('hidden', mode === 'audio');
  $('localVideo').classList.toggle('hidden', mode === 'audio');
  $('callStatus').textContent = '正在连接…';
  $('callScreen').classList.remove('hidden', 'compact-call');
  $('toggleCameraBtn').classList.toggle('hidden', mode === 'audio');
  $('toggleMicBtn').classList.remove('off');
}
async function startLocalMedia(mode) {
  const constraints = { audio: true, video: mode === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false };
  state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
  $('localVideo').srcObject = state.localStream;
  $('localVideo').classList.toggle('hidden', mode === 'audio');
}
function createPeerConnection() {
  if (state.peerConnection) state.peerConnection.close();
  state.queuedIce = [];
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  state.peerConnection = pc;
  if (state.localStream) state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  pc.onicecandidate = (event) => {
    if (event.candidate && state.callPeer) state.socket?.emit('call:ice', { to: state.callPeer, candidate: event.candidate.toJSON() });
  };
  pc.ontrack = (event) => {
    state.remoteStream = event.streams[0];
    $('remoteVideo').srcObject = state.remoteStream;
    if (state.callMode === 'video' && event.track.kind === 'video') $('remotePlaceholder').classList.add('hidden');
    $('callStatus').textContent = '通话已连接';
    $('callLiveDot')?.classList.add('active');
    $('remoteVideo').play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') $('callStatus').textContent = '通话已连接';
    else if (pc.connectionState === 'connecting') $('callStatus').textContent = '正在连接…';
    else if (pc.connectionState === 'failed') $('callStatus').textContent = '网络连接失败，请尝试重拨';
    else if (pc.connectionState === 'disconnected') $('callStatus').textContent = '网络不稳定…';
  };
  return pc;
}
async function onCallAccepted({ from }) {
  if (Number(from) !== Number(state.callPeer) || state.callRole !== 'caller') return;
  state.callPending = false;
  try {
    const pc = state.peerConnection || createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const response = await socketAck('call:offer', { to: state.callPeer, sdp: pc.localDescription });
    if (!response.ok) throw new Error(response.error || '信令发送失败');
    $('callStatus').textContent = '正在建立连接…';
  } catch (err) { toast(err.message || '无法建立通话。'); cleanupCall(true); }
}
async function onCallOffer({ from, sdp }) {
  if (Number(from) !== Number(state.callPeer) || state.callRole !== 'callee' || !state.peerConnection) return;
  try {
    const pc = state.peerConnection;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushQueuedIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const response = await socketAck('call:answer', { to: state.callPeer, sdp: pc.localDescription });
    if (!response.ok) throw new Error(response.error || '应答发送失败');
    $('callStatus').textContent = '正在建立连接…';
  } catch (err) { toast(err.message || '接听失败。'); cleanupCall(true); }
}
async function onCallAnswer({ from, sdp }) {
  if (Number(from) !== Number(state.callPeer) || !state.peerConnection) return;
  try {
    await state.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushQueuedIce();
  } catch (err) { toast(`建立通话失败：${err.message}`); cleanupCall(true); }
}
async function onRemoteIce({ from, candidate }) {
  if (Number(from) !== Number(state.callPeer) || !candidate) return;
  try {
    if (!state.peerConnection || !state.peerConnection.remoteDescription) state.queuedIce.push(candidate);
    else await state.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) { console.warn('Could not add ICE candidate:', err); }
}
async function flushQueuedIce() {
  if (!state.peerConnection?.remoteDescription) return;
  const candidates = state.queuedIce.splice(0);
  for (const candidate of candidates) {
    try { await state.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (err) { console.warn('Could not add queued ICE candidate:', err); }
  }
}
async function acceptIncomingCall() {
  const call = state.incomingCall;
  if (!call) return;
  $('incomingModal').classList.add('hidden');
  state.incomingCall = null;
  state.callPeer = call.from;
  state.callMode = call.mode === 'audio' ? 'audio' : 'video';
  state.callRole = 'callee';
  state.callPending = false;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('请在 HTTPS 网站或现代浏览器中接听通话。');
    const friend = state.friends.find(f => Number(f.id) === Number(call.from));
    await prepareCallUI(friend?.username || call.fromUsername, state.callMode);
    await startLocalMedia(state.callMode);
    createPeerConnection();
    const response = await socketAck('call:accept', { to: call.from });
    if (!response.ok) throw new Error(response.error || '无法接听。');
    $('callStatus').textContent = '已接听，正在连接…';
  } catch (err) {
    toast(err && err.name ? mediaAccessError(err, state.callMode) : (err.message || '无法接听通话。'), 6500);
    state.socket?.emit('call:reject', { to: call.from });
    cleanupCall(false);
  }
}
function rejectIncomingCall() {
  if (state.incomingCall) state.socket?.emit('call:reject', { to: state.incomingCall.from });
  state.incomingCall = null;
  $('incomingModal').classList.add('hidden');
}
function cleanupCall(notifyPeer) {
  if (state.callEnding) return;
  state.callEnding = true;
  const peer = state.callPeer;
  if (notifyPeer && peer && state.socket?.connected) state.socket.emit('call:end', { to: peer });
  try { state.peerConnection?.close(); } catch { /* ignore */ }
  state.peerConnection = null;
  if (state.localStream) state.localStream.getTracks().forEach(track => track.stop());
  state.localStream = null;
  if (state.remoteStream) state.remoteStream.getTracks().forEach(track => track.stop());
  state.remoteStream = null;
  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('callScreen').classList.add('hidden');
  $('callScreen').classList.remove('compact-call');
  $('incomingModal').classList.add('hidden');
  state.callPeer = null; state.callMode = 'video'; state.callRole = null; state.callPending = false;
  state.queuedIce = []; state.incomingCall = null;
  state.callEnding = false;
}
async function openSessions() {
  $('sessionsError').textContent = '';
  $('sessionsList').textContent = '正在加载…';
  $('sessionsModal').classList.remove('hidden');
  try {
    const result = await api('/api/sessions');
    $('sessionsList').replaceChildren();
    for (const session of result.sessions) {
      if (session.revoked) continue;
      const row = document.createElement('div');
      row.className = 'request-row';
      const label = document.createElement('span');
      label.textContent = `${session.current ? '当前设备' : '其他设备'} · 创建于 ${new Date(session.createdAt * 1000).toLocaleString()}`;
      row.append(label);
      if (!session.current) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'ghost-button'; button.textContent = '退出';
        button.addEventListener('click', async () => {
          try { await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }); await openSessions(); }
          catch (err) { $('sessionsError').textContent = err.message; }
        });
        row.append(button);
      }
      $('sessionsList').append(row);
    }
    if (!result.sessions.some(x => !x.revoked)) $('sessionsList').textContent = '没有有效会话。';
  } catch (err) { $('sessionsError').textContent = err.message; }
}
async function revokeOtherSessions() {
  try {
    const result = await api('/api/sessions/revoke-others', { method: 'POST' });
    toast(`已退出 ${result.revoked} 个其他设备。`);
    await openSessions();
  } catch (err) { $('sessionsError').textContent = err.message; }
}
async function logout(showMessage = true, message = '') {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch { /* Clear local UI even if the network is unavailable. */ }
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  cleanupCall(false);
  state.user = null; state.friends = []; state.selectedFriend = null;
  for (const url of state.attachmentUrls.values()) URL.revokeObjectURL(url);
  state.attachmentUrls.clear();
  $('searchResults').classList.add('hidden'); $('requestsList').classList.add('hidden');
  $('friendsList').replaceChildren(); $('messageList').replaceChildren();
  document.querySelector('.workspace').classList.remove('chat-open');
  $('chatView').classList.add('hidden'); $('welcomePanel').classList.remove('hidden');
  showAuth(message || (showMessage ? '' : ''));
  if (message) toast(message);
}

$('copyPublicIdBtn').addEventListener('click', async () => {
  const publicId = String(state.user?.publicId || '');
  if (!publicId) return toast('用户 ID 尚未加载，请刷新页面。');
  try {
    await navigator.clipboard.writeText(publicId);
    toast('微聊 ID 已复制。');
  } catch {
    const field = document.createElement('textarea');
    field.value = publicId; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
    document.body.append(field); field.select();
    const copied = document.execCommand('copy'); field.remove();
    toast(copied ? '微聊 ID 已复制。' : `你的微聊 ID：${publicId}`);
  }
});
initCountryPickers();
$('avatarFile').addEventListener('change', previewAvatarChoice);
$('resetAvatarBtn').addEventListener('click', resetAvatarChoice);
$('loginTab').addEventListener('click', () => setAuthMode('login'));
$('registerTab').addEventListener('click', () => setAuthMode('register'));
$('authForm').addEventListener('submit', handleAuth);
$('captchaVerifyBtn').addEventListener('click', verifyRegistrationHuman);
$('completeRegistrationBtn').addEventListener('click', completeRegistration);
$('cancelRegistrationBtn').addEventListener('click', () => { $('registrationVerifyModal').classList.add('hidden'); pendingRegistrationId=''; registrationAppCodeIssued=false; });
$('appCodeInput').addEventListener('input', () => { $('completeRegistrationBtn').disabled = !/^\d{6}$/.test($('appCodeInput').value.trim()); });
$('logoutBtn').addEventListener('click', () => logout(true));
$('sessionsBtn').addEventListener('click', openSessions);
$('closeSessionsBtn').addEventListener('click', () => $('sessionsModal').classList.add('hidden'));
$('revokeOtherSessionsBtn').addEventListener('click', revokeOtherSessions);
$('refreshBtn').addEventListener('click', async () => { try { await Promise.all([loadFriends(), loadRequests()]); toast('联系人已刷新。'); } catch (e) { toast(e.message); } });
$('searchForm').addEventListener('submit', searchUsers);
$('requestsToggle').addEventListener('click', () => $('requestsList').classList.toggle('hidden'));
$('friendsList').addEventListener('click', (event) => { const row = event.target.closest('[data-friend-id]'); if (row) selectFriend(Number(row.dataset.friendId)); });
$('messageForm').addEventListener('submit', submitMessage);
$('messageInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('messageForm').requestSubmit(); }
});
$('messageInput').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = `${Math.min(this.scrollHeight, 120)}px`; });
$('photoBtn').addEventListener('click', () => $('photoInput').click());
$('fileBtn').addEventListener('click', () => $('fileInput').click());
$('photoInput').addEventListener('change', async function () { if (this.files?.length) await uploadFiles(Array.from(this.files)); this.value = ''; });
$('fileInput').addEventListener('change', async function () { if (this.files?.length) await uploadFiles(Array.from(this.files)); this.value = ''; });
$('audioCallBtn').addEventListener('click', () => state.selectedFriend && startCall(state.selectedFriend, 'audio'));
$('videoCallBtn').addEventListener('click', () => state.selectedFriend && startCall(state.selectedFriend, 'video'));
$('acceptCallBtn').addEventListener('click', acceptIncomingCall);
$('rejectCallBtn').addEventListener('click', rejectIncomingCall);
$('hangupBtn').addEventListener('click', () => cleanupCall(true));
$('minimizeCallBtn').addEventListener('click', () => $('callScreen').classList.toggle('compact-call'));
$('backToContacts').addEventListener('click', () => document.querySelector('.workspace').classList.remove('chat-open'));
$('toggleMicBtn').addEventListener('click', () => {
  const track = state.localStream?.getAudioTracks()[0]; if (!track) return;
  track.enabled = !track.enabled; $('toggleMicBtn').classList.toggle('off', !track.enabled);
  $('toggleMicBtn').querySelector('span').textContent = track.enabled ? '麦克风' : '已静音';
});
$('toggleCameraBtn').addEventListener('click', () => {
  const track = state.localStream?.getVideoTracks()[0]; if (!track) return;
  track.enabled = !track.enabled; $('toggleCameraBtn').classList.toggle('off', !track.enabled);
  $('toggleCameraBtn').querySelector('span').textContent = track.enabled ? '摄像头' : '已关闭';
});

startApp();

/* =========================================================================
 * Gerenciador de WhatsApp — front-end (somente leitura)
 * Agora consome a API mock por HTTP (server/mock-server.js) e recebe
 * mensagens novas em tempo real via SSE. Nenhuma regra de UI mudou;
 * apenas a camada `api` deixou de ser mock inline e passou a usar fetch.
 * ========================================================================= */

/* ------------------------------- API LAYER ------------------------------ */
const api = {
  async _get(url) {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
    return r.json();
  },
  getNumbers() { return this._get('/api/numbers'); },
  getConversations(numberId, folder = 'conversas', q = '') {
    const qs = new URLSearchParams({ folder }); if (q) qs.set('q', q);
    return this._get(`/api/numbers/${numberId}/conversations?${qs}`);
  },
  getMessages(numberId, convId) { return this._get(`/api/numbers/${numberId}/conversations/${convId}/messages`); },
  getDeleted(numberId) { return this._get(`/api/numbers/${numberId}/deleted`); },
  getMedia(numberId, kind) { return this._get(`/api/numbers/${numberId}/media?kind=${kind}`); },
  streamUrl(numberId) { return `/api/numbers/${numberId}/stream`; },
};

/* ------------------------------- ESTADO --------------------------------- */
const state = {
  numberId: 'n1', folder: 'conversas', convId: null, search: '',
  numbers: [], convsById: {}, msgCache: {}, deletedCount: 0, es: null, user: null, revealDeleted: false,
};

const FOLDERS = [
  { id: 'conversas',  icon: '💬', label: 'Conversas' },
  { id: 'trancadas',  icon: '🔒', label: 'Trancadas' },
  { id: 'apagadas',   icon: '🗑️', label: 'Apagadas' },
  { id: 'midias',     icon: '🖼️', label: 'Mídias' },
  { id: 'figurinhas', icon: '😎', label: 'Figurinhas' },
  { id: 'gifs',       icon: '🎞️', label: 'GIFs' },
];

/* ------------------------------- HELPERS -------------------------------- */
const AVATAR_COLORS = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#f2a65a'];
const colorFor = (s) => AVATAR_COLORS[[...(s || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
const initials = (name) => (name || '?').split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
function previewText(m) {
  if (!m) return '';
  if (m.type === 'image') return '🖼️ Foto';
  if (m.type === 'sticker') return '😎 Figurinha';
  if (m.type === 'gif') return '🎞️ GIF';
  if (m.type === 'audio') return '🎤 Áudio ' + (m.text || '');
  if (m.type === 'doc') return '📄 ' + esc(m.text);
  return esc(m.text);
}

/* ------------------------------- RENDER --------------------------------- */
async function renderRail() {
  const wrap = $('#railFolders');
  wrap.innerHTML = '';
  for (const f of FOLDERS) {
    const b = el('button', 'rail__btn' + (state.folder === f.id ? ' is-active' : ''));
    b.title = f.label; b.innerHTML = f.icon;
    if (f.id === 'apagadas' && state.deletedCount) b.appendChild(el('span', 'rail__count', String(state.deletedCount)));
    b.onclick = () => { state.folder = f.id; state.convId = null; renderAll(); };
    wrap.appendChild(b);
  }
}

function renderNumberSwitch() {
  const n = state.numbers.find(x => x.id === state.numberId) || state.numbers[0];
  if (!n) return;
  $('#numAvatar').textContent = initials(n.name);
  $('#numAvatar').style.background = colorFor(n.name);
  $('#numName').textContent = n.name;
  $('#numPhone').textContent = n.phone;
  const menu = $('#numMenu');
  menu.innerHTML = '';
  for (const x of state.numbers) {
    const li = el('li');
    const av = el('span', 'numswitch__avatar', initials(x.name));
    av.style.background = colorFor(x.name);
    li.appendChild(av);
    li.appendChild(el('span', '', `<div style="font-weight:600">${esc(x.name)}</div><div style="font-size:12px;color:var(--text-2)">${esc(x.phone)}</div>`));
    li.appendChild(el('span', 'pill pill--' + x.type, x.type));
    li.onclick = () => { switchNumber(x.id); menu.hidden = true; };
    menu.appendChild(li);
  }
}

async function renderList() {
  const body = $('#listBody'), title = $('#listTitle');
  body.innerHTML = '<div class="empty-note">Carregando…</div>';

  try {
    if (state.folder === 'apagadas') {
      title.textContent = 'Conversas apagadas';
      const items = await api.getDeleted(state.numberId);
      body.innerHTML = '';
      if (!items.length) return body.appendChild(el('div', 'empty-note', 'Nenhuma mensagem apagada neste número.'));
      for (const d of items) {
        const dBody = d.originalType === 'image' ? `🖼️ Foto apagada${d.text ? ' — ' + esc(d.text) : ''}`
          : d.originalType === 'video' ? `🎥 Vídeo apagado${d.text ? ' — ' + esc(d.text) : ''}`
          : d.originalType === 'sticker' ? '😎 Figurinha apagada'
          : esc(d.text);
        const box = el('div', 'deleted-item');
        box.innerHTML = `
          <div class="deleted-item__head">
            <span class="deleted-item__peer">${esc(d.conv)}</span>
            <span class="deleted-item__when">apagada ${esc(d.when)}</span>
          </div>
          <div class="deleted-item__body">${dBody}</div>
          <div class="deleted-item__sub">${d.dir === 'in' ? 'Recebida' : 'Enviada'} · clique para ver na conversa</div>`;
        box.style.cursor = 'pointer';
        box.onclick = () => openDeletedConversation(d.convId);
        body.appendChild(box);
      }
      return;
    }

    if (['midias', 'figurinhas', 'gifs'].includes(state.folder)) {
      title.textContent = { midias: 'Mídias', figurinhas: 'Figurinhas', gifs: 'GIFs' }[state.folder];
      const items = await api.getMedia(state.numberId, state.folder);
      body.innerHTML = '';
      if (!items.length) return body.appendChild(el('div', 'empty-note', 'Nada por aqui ainda.'));
      const g = el('div', 'gallery');
      for (const it of items) {
        const cell = el('div', 'media-cell');
        const t = el('div', 'tile', it.media || '🖼️');
        if (it.kind === 'video') t.appendChild(el('span', 'tile__badge', '▶ vídeo'));
        if (state.folder === 'gifs') t.appendChild(el('span', 'tile__badge', 'GIF'));
        if (it.viewOnce) t.appendChild(el('span', 'tile__badge tile__badge--vo', '👁 1x'));
        cell.appendChild(t);
        cell.appendChild(el('div', 'media-cap', `
          <span class="media-cap__contact" title="${esc(it.contact || '')}">${esc(it.contact || '—')}</span>
          <span class="media-cap__meta ${it.dir === 'in' ? 'is-in' : 'is-out'}">${it.dir === 'in' ? '↙ Recebida' : '↗ Enviada'}${it.viewOnce ? ' · visualização única' : ''}</span>`));
        g.appendChild(cell);
      }
      body.appendChild(g);
      return;
    }

    // conversas / trancadas
    title.textContent = state.folder === 'trancadas' ? 'Conversas trancadas' : 'Conversas';
    const convs = await api.getConversations(state.numberId, state.folder, state.search);
    for (const c of convs) state.convsById[c.id] = c;
    body.innerHTML = '';
    if (!convs.length) return body.appendChild(el('div', 'empty-note', 'Nenhuma conversa encontrada.'));
    for (const c of convs) body.appendChild(renderConvItem(c));
  } catch (e) {
    body.innerHTML = `<div class="empty-note">Falha ao carregar.<br><small>${esc(e.message)}</small></div>`;
  }
}

function renderConvItem(c) {
  const item = el('div', 'conv' + (state.convId === c.id ? ' is-active' : ''));
  item.dataset.conv = c.id;
  const av = el('div', 'avatar', initials(c.name)); av.style.background = colorFor(c.name);
  const preview = c.last && c.last.type === 'deleted'
    ? '<span class="tag tag--deleted">🚫 mensagem apagada</span>'
    : `<span class="conv__preview-text">${previewText(c.last)}</span>`;
  item.appendChild(av);
  item.appendChild(el('div', 'conv__main', `
    <div class="conv__row">
      <span class="conv__name">${esc(c.name)}${c.locked ? ' <span class="tag tag--lock">🔒 trancada</span>' : ''}</span>
      <span class="conv__time ${c.unread ? 'is-unread' : ''}">${c.last ? c.last.time : ''}</span>
    </div>
    <div class="conv__preview">
      ${preview}
      ${c.unread ? `<span class="conv__badge">${c.unread}</span>` : ''}
    </div>`));
  item.onclick = () => openConversation(c.id);
  return item;
}

async function openConversation(convId) {
  state.convId = convId;
  state.revealDeleted = false;
  const c = state.convsById[convId];
  if (c) c.unread = 0;
  document.getElementById('app').classList.add('show-chat');
  renderList();
  await renderChat();
}

// Abre a conversa a partir da aba "Apagadas", revelando o conteúdo apagado no contexto.
async function openDeletedConversation(convId) {
  if (!convId) return;
  if (!state.convsById[convId]) {
    try { const convs = await api.getConversations(state.numberId, 'conversas'); for (const c of convs) state.convsById[c.id] = c; } catch (e) {}
  }
  state.convId = convId;
  state.revealDeleted = true;
  document.getElementById('app').classList.add('show-chat');
  await renderChat();
}

async function renderChat() {
  const empty = $('#chatEmpty'), view = $('#chatView');
  const c = state.convsById[state.convId];
  const mediaFolder = ['midias', 'figurinhas', 'gifs'].includes(state.folder);
  if (!state.convId || mediaFolder || !c) { empty.hidden = false; view.hidden = true; return; }

  empty.hidden = true; view.hidden = false;
  $('#peerAvatar').textContent = initials(c.name);
  $('#peerAvatar').style.background = colorFor(c.name);
  $('#peerName').textContent = c.name;
  $('#peerSub').textContent = c.phone;
  $('#chatFlags').innerHTML = c.locked ? '<span class="tag tag--lock">🔒 Conversa trancada</span>' : '';

  const box = $('#messages');
  box.innerHTML = '<div class="empty-note">Carregando mensagens…</div>';
  let msgs = state.msgCache[state.convId];
  if (!msgs) { msgs = await api.getMessages(state.numberId, state.convId); state.msgCache[state.convId] = msgs; }
  if (state.convId !== c.id) return; // trocou durante o fetch

  box.innerHTML = '';
  if (state.revealDeleted) box.appendChild(el('div', 'reveal-banner', '🗑️ Exibindo a conversa com o conteúdo apagado preservado, como estava antes.'));
  let lastDay = null;
  for (const mm of msgs) {
    if (mm.day !== lastDay) { box.appendChild(el('div', 'daysep', mm.day)); lastDay = mm.day; }
    box.appendChild(renderMessage(mm));
  }
  const firstRevealed = box.querySelector('.msg--revealed');
  if (state.revealDeleted && firstRevealed) firstRevealed.scrollIntoView({ block: 'center' });
  else box.scrollTop = box.scrollHeight;
}

function renderMessage(m) {
  if (m.type === 'deleted') {
    if (state.revealDeleted) {
      const r = el('div', 'msg msg--' + m.dir + ' msg--revealed');
      const ot = m.originalType || 'text';
      let ri = '';
      if (m.sender && m.dir === 'in') ri += `<div class="msg__sender">${esc(m.sender)}</div>`;
      if (ot === 'image') ri += `<div class="msg__media" style="background:var(--panel-3);height:150px;display:flex;align-items:center;justify-content:center;font-size:46px">${m.media || '🖼️'}</div>`;
      else if (ot === 'video') ri += `<div class="msg__media" style="background:var(--panel-3);height:140px;display:flex;align-items:center;justify-content:center;font-size:44px">${m.media || '🎥'}<span class="tile__badge" style="position:static;margin-left:8px">▶ vídeo</span></div>`;
      else if (ot === 'sticker') ri += `<div class="msg__sticker">${m.media || '😀'}</div>`;
      if (m.text && ot !== 'sticker') ri += `<div>${esc(m.text)}</div>`;
      ri += `<div class="msg__meta"><span class="tag tag--deleted">🚫 apagada ${esc(m.deletedAt || '')}</span><span class="msg__time">${m.time || ''}</span></div>`;
      r.innerHTML = ri;
      return r;
    }
    return el('div', 'msg msg--' + m.dir + ' msg--deleted',
      `🚫 Esta mensagem foi apagada <span class="msg__time">· ${m.deletedAt || ''}</span>`);
  }
  const n = el('div', 'msg msg--' + m.dir);
  let inner = '';
  if (m.sender && m.dir === 'in') inner += `<div class="msg__sender">${esc(m.sender)}</div>`;
  if (m.type === 'image') inner += `<div class="msg__media" style="background:var(--panel-3);height:180px;display:flex;align-items:center;justify-content:center;font-size:54px">${m.media || '🖼️'}</div>`;
  if (m.type === 'sticker') inner += `<div class="msg__sticker">${m.media || '😀'}</div>`;
  if (m.type === 'gif') inner += `<div class="msg__media" style="background:var(--panel-3);height:150px;display:flex;align-items:center;justify-content:center;font-size:48px">${m.media || '🎞️'}<span class="tile__badge" style="position:static;margin-left:8px">GIF</span></div>`;
  if (m.type === 'audio') inner += `<div class="msg__audio">▶️ <span class="msg__audio-bar"></span><span>${esc(m.text)}</span></div>`;
  if (m.type === 'doc') inner += `<div class="msg__doc">📄 <span>${esc(m.text)}</span></div>`;
  if (m.text && !['audio', 'doc', 'sticker'].includes(m.type)) inner += `<div>${esc(m.text)}</div>`;
  inner += `<div class="msg__meta"><span class="msg__time">${m.time || ''}</span>${m.dir === 'out' ? ' <span class="msg__time">✓✓</span>' : ''}</div>`;
  n.innerHTML = inner;
  return n;
}

/* --------------------------- TEMPO REAL (SSE) --------------------------- */
function openStream(numberId) {
  if (state.es) state.es.close();
  const es = new EventSource(api.streamUrl(numberId));
  state.es = es;
  es.addEventListener('message', (ev) => {
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    onIncoming(data);
  });
  es.onerror = () => { $('#liveBadge').style.opacity = '.4'; };
  es.addEventListener('ready', () => { $('#liveBadge').style.opacity = '1'; });
}

function onIncoming({ convId, message, unread }) {
  // atualiza cache de mensagens se já carregado
  if (state.msgCache[convId]) state.msgCache[convId].push(message);
  // atualiza resumo da conversa
  const c = state.convsById[convId];
  if (c) {
    c.last = { type: message.type, text: message.text, time: message.time };
    c.unread = state.convId === convId ? 0 : (unread ?? (c.unread || 0) + 1);
  }
  // se a conversa está aberta, injeta o balão
  if (state.convId === convId && !['apagadas','midias','figurinhas','gifs'].includes(state.folder)) {
    const box = $('#messages');
    box.appendChild(renderMessage(message));
    box.scrollTop = box.scrollHeight;
  }
  // atualiza a lista (prévia/badge) se estamos numa aba de conversas
  if (['conversas', 'trancadas'].includes(state.folder)) renderList();
}

/* ------------------------------ INTERAÇÕES ------------------------------ */
async function switchNumber(id) {
  state.numberId = id; state.convId = null; state.convsById = {}; state.msgCache = {};
  await loadNumberContext();
  openStream(id);
  renderAll();
}

async function loadNumberContext() {
  try { state.deletedCount = (await api.getDeleted(state.numberId)).length; }
  catch { state.deletedCount = 0; }
}

$('#numSwitch').addEventListener('click', () => { const menu = $('#numMenu'); menu.hidden = !menu.hidden; });
document.addEventListener('click', (e) => {
  if (!e.target.closest('#numSwitch') && !e.target.closest('#numMenu')) $('#numMenu').hidden = true;
});
let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  state.search = e.target.value;
  clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 180);
});
document.querySelectorAll('.rail__btn[data-action]').forEach(b => {
  b.addEventListener('click', () => {
    const a = b.dataset.action;
    if (a === 'settings') window.AdminUI && window.AdminUI.open();
    if (a === 'logout') {
      if (confirm('Encerrar a sessão do usuário?\n\n(Isto faz logoff do gerenciador; não desconecta o número do WhatsApp.)'))
        logout();
    }
  });
});

/* ------------------------------- RENDER ALL ----------------------------- */
async function renderAll() {
  renderNumberSwitch();
  await renderRail();
  await renderList();
  await renderChat();
}

/* ------------------------------- LOGIN ---------------------------------- */
function showLogin() { $('#loginScreen').hidden = false; $('#app').hidden = true; }
function hideLogin() { $('#loginScreen').hidden = true; $('#app').hidden = false; }

async function startApp(user) {
  state.user = user;
  hideLogin();
  let nums = await api.getNumbers();
  if (user.role !== 'admin') nums = nums.filter(n => (user.numbers || []).includes(n.id));
  state.numbers = nums;
  state.numberId = nums[0] ? nums[0].id : null;
  state.convId = null; state.convsById = {}; state.msgCache = {};
  await loadNumberContext();
  await renderAll();
  if (state.numberId) openStream(state.numberId);
}

function logout() {
  try { sessionStorage.removeItem('wa_session'); } catch {}
  if (state.es) { state.es.close(); state.es = null; }
  state.user = null;
  showLogin();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPass').value;
  const msg = $('#loginMsg'); msg.textContent = 'Entrando…'; msg.style.color = 'var(--text-2)';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await r.json();
    if (!r.ok || !data.ok) { msg.textContent = 'E-mail ou senha inválidos.'; msg.style.color = 'var(--danger)'; return; }
    try { sessionStorage.setItem('wa_session', JSON.stringify(data.user)); } catch {}
    msg.textContent = '';
    await startApp(data.user);
  } catch (err) {
    msg.textContent = 'Falha ao conectar à API. Rode: node server/mock-server.js';
    msg.style.color = 'var(--danger)';
  }
});

// Outra aba concluiu uma conexão (número novo) → recarrega para refletir.
window.addEventListener('storage', (e) => {
  if (e.key === 'wa_extra_numbers' && state.user) location.reload();
});

// Permite ao painel de administração atualizar a lista de números sem recarregar.
window.AppRefreshNumbers = async function () {
  try {
    let nums = await api.getNumbers();
    if (state.user && state.user.role !== 'admin') nums = nums.filter(n => (state.user.numbers || []).includes(n.id));
    state.numbers = nums;
    renderNumberSwitch();
  } catch (e) {}
};

/* ------------------------------- INÍCIO --------------------------------- */
(async function init() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('wa_session') || 'null'); } catch {}
  if (saved) {
    try { await startApp(saved); return; } catch { logout(); }
  }
  showLogin();
})();

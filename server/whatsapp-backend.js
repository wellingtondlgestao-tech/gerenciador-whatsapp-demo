/* =========================================================================
 * Backend REAL do Gerenciador de WhatsApp (Cloud API) — somente leitura.
 * Recebe webhooks da Meta, armazena e serve o painel + /api + SSE.
 * Node puro (sem dependências).
 *
 *   PORT=3000 VERIFY_TOKEN=... WHATSAPP_TOKEN=... APP_SECRET=... \
 *   WA_NUMBERS='[{"id":"n1","name":"Atendimento","phone":"+55 11 90000-0001","phone_number_id":"1234567890","type":"comercial"}]' \
 *   node server/whatsapp-backend.js
 *
 * Variáveis:
 *   PORT            porta (Render define automaticamente)
 *   VERIFY_TOKEN    token de verificação do webhook (você escolhe; repete na Meta)
 *   WHATSAPP_TOKEN  token da Graph API (para baixar mídia)
 *   APP_SECRET      segredo do app (valida a assinatura X-Hub-Signature-256) — opcional
 *   WA_NUMBERS      JSON com os números conectados (id, name, phone, phone_number_id, type)
 *   LOGIN_EMAIL     e-mail de acesso ao painel (padrão: admin@empresa.com)
 *   LOGIN_PASSWORD  senha de acesso ao painel (padrão: trocar123)
 * ========================================================================= */
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verifique-me';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const APP_SECRET = process.env.APP_SECRET || '';
const LOGIN_EMAIL = (process.env.LOGIN_EMAIL || 'admin@empresa.com').toLowerCase();
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'trocar123';
const ROOT = path.join(__dirname, '..'); // arquivos da UI na raiz do repo

let NUMBERS = [];
try { NUMBERS = JSON.parse(process.env.WA_NUMBERS || '[]'); } catch { NUMBERS = []; }
if (!Array.isArray(NUMBERS)) NUMBERS = [];
// Fallback: um número via variáveis simples
if (!NUMBERS.length && process.env.PHONE_NUMBER_ID) {
  NUMBERS = [{ id: 'n1', name: process.env.DISPLAY_NAME || 'Número', phone: process.env.DISPLAY_PHONE || '', phone_number_id: process.env.PHONE_NUMBER_ID, type: 'comercial' }];
}
NUMBERS.forEach((n) => { n.status = 'conectado'; });
const numberByPhoneId = (pid) => NUMBERS.find((n) => String(n.phone_number_id) === String(pid));

/* ------------------------- ARMAZENAMENTO (memória) ---------------------- *
 * store[numberId] = { convs: Map(waId -> {id,name,phone,locked,unread,messages:[]}) }
 * Em produção isto vira um banco. Para o teste, memória basta.
 * ----------------------------------------------------------------------- */
const store = {};
NUMBERS.forEach((n) => { store[n.id] = { convs: new Map() }; });

function hhmm(tsSeconds) {
  const d = tsSeconds ? new Date(Number(tsSeconds) * 1000) : new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function dayLabel(tsSeconds) {
  const d = tsSeconds ? new Date(Number(tsSeconds) * 1000) : new Date();
  const today = new Date();
  const isSame = d.toDateString() === today.toDateString();
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (isSame) return 'Hoje';
  if (d.toDateString() === y.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR');
}

function ensureConv(numberId, waId, name) {
  const s = store[numberId]; if (!s) return null;
  if (!s.convs.has(waId)) s.convs.set(waId, { id: waId, name: name || waId, phone: '+' + waId, locked: false, unread: 0, messages: [] });
  const c = s.convs.get(waId);
  if (name && c.name === waId) c.name = name;
  return c;
}

// Converte uma mensagem da Cloud API para o formato da UI.
function toUiMessage(msg, dir) {
  const base = { id: msg.id, dir, time: hhmm(msg.timestamp), day: dayLabel(msg.timestamp) };
  switch (msg.type) {
    case 'text': return Object.assign(base, { type: 'text', text: msg.text && msg.text.body });
    case 'image': return Object.assign(base, { type: 'image', media: '🖼️', text: (msg.image && msg.image.caption) || '', mediaId: msg.image && msg.image.id });
    case 'video': return Object.assign(base, { type: 'image', media: '🎥', text: (msg.video && msg.video.caption) || 'Vídeo', mediaId: msg.video && msg.video.id });
    case 'audio': return Object.assign(base, { type: 'audio', text: 'Áudio', mediaId: msg.audio && msg.audio.id });
    case 'sticker': return Object.assign(base, { type: 'sticker', media: '🧩', mediaId: msg.sticker && msg.sticker.id });
    case 'document': return Object.assign(base, { type: 'doc', text: (msg.document && (msg.document.filename || 'Documento')) });
    default: return Object.assign(base, { type: 'text', text: '[' + msg.type + ']' });
  }
}

/* ----------------------------- SSE (tempo real) ------------------------- */
const clients = new Map(); // numberId -> Set(res)
function subscribe(numberId, res) {
  if (!clients.has(numberId)) clients.set(numberId, new Set());
  clients.get(numberId).add(res);
  res.on('close', () => clients.get(numberId) && clients.get(numberId).delete(res));
}
function broadcast(numberId, event, data) {
  const set = clients.get(numberId); if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) { try { res.write(payload); } catch (e) {} }
}

/* --------------------------- PROCESSA O WEBHOOK ------------------------- */
function handleWebhook(body) {
  if (!body || body.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const pid = value.metadata && value.metadata.phone_number_id;
      const number = numberByPhoneId(pid);
      if (!number) { console.warn('Webhook de phone_number_id não configurado:', pid); continue; }
      const contacts = {};
      for (const c of value.contacts || []) contacts[c.wa_id] = c.profile && c.profile.name;

      // Mensagens recebidas
      for (const msg of value.messages || []) {
        const waId = msg.from;
        const conv = ensureConv(number.id, waId, contacts[waId]);
        const ui = toUiMessage(msg, 'in');
        conv.messages.push(ui);
        conv.unread = (conv.unread || 0) + 1;
        broadcast(number.id, 'message', { convId: conv.id, message: ui, unread: conv.unread });
        console.log(`[${number.id}] recebida de ${conv.name}: ${ui.text || ui.type}`);
      }
      // Ecos (mensagens enviadas pelo próprio número, quando habilitado)
      for (const msg of value.message_echoes || []) {
        const waId = msg.to || (msg.recipient_id);
        const conv = ensureConv(number.id, waId, contacts[waId]);
        const ui = toUiMessage(msg, 'out');
        conv.messages.push(ui);
        broadcast(number.id, 'message', { convId: conv.id, message: ui, unread: conv.unread || 0 });
      }
    }
  }
}

/* ------------------------------ CONSULTAS ------------------------------- */
function listConversations(numberId, folder, q) {
  const s = store[numberId]; if (!s) return [];
  let list = [...s.convs.values()];
  if (folder === 'trancadas') list = list.filter((c) => c.locked);
  if (q) { const t = q.toLowerCase(); list = list.filter((c) => c.name.toLowerCase().includes(t) || c.messages.some((m) => (m.text || '').toLowerCase().includes(t))); }
  list.sort((a, b) => (b.messages.length ? b.messages[b.messages.length - 1].time : '').localeCompare(a.messages.length ? a.messages[a.messages.length - 1].time : ''));
  return list.map((c) => {
    const last = c.messages[c.messages.length - 1];
    return { id: c.id, name: c.name, phone: c.phone, locked: c.locked, unread: c.unread, last: last ? { type: last.type, text: last.text, time: last.time } : null };
  });
}
function listMedia(numberId, kind) {
  const s = store[numberId]; if (!s) return [];
  const wants = kind === 'figurinhas' ? ['sticker'] : kind === 'gifs' ? ['gif'] : ['image'];
  const out = [];
  for (const c of s.convs.values()) for (const m of c.messages) {
    const isImg = m.type === 'image';
    const isSticker = m.type === 'sticker';
    if ((kind === 'midias' && isImg) || (kind === 'figurinhas' && isSticker)) {
      out.push({ media: m.media || '🖼️', kind: 'image', contact: c.name, dir: m.dir, time: m.time });
    }
  }
  return out;
}

/* ------------------------------ UTILITÁRIOS ----------------------------- */
function sendJSON(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
function validSignature(raw, header) {
  if (!APP_SECRET) return true; // sem segredo configurado, não valida (apenas teste)
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header)); } catch { return false; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };
function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    // Para o backend real, a UI NÃO usa o mock do navegador: removemos o script.
    if (ext === '.html') data = Buffer.from(String(data).replace(/\s*<script src="mock-browser\.js"><\/script>/g, ''));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* -------------------------- SESSÕES DE CONEXÃO -------------------------- */
const CONNECT = new Map();
const gen6 = () => String(Math.floor(100000 + Math.random() * 900000));
const newToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/* ------------------------------- SERVIDOR ------------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname, method = req.method;

  // ---- Webhook da Meta ----
  if (p === '/webhook' && method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === VERIFY_TOKEN) { res.writeHead(200); return res.end(challenge || ''); }
    res.writeHead(403); return res.end('Forbidden');
  }
  if (p === '/webhook' && method === 'POST') {
    const raw = await readRaw(req);
    if (!validSignature(raw, req.headers['x-hub-signature-256'])) { res.writeHead(401); return res.end('invalid signature'); }
    let body = {}; try { body = JSON.parse(raw.toString('utf8')); } catch {}
    try { handleWebhook(body); } catch (e) { console.error('Erro no webhook:', e); }
    res.writeHead(200); return res.end('EVENT_RECEIVED');
  }

  // ---- API ----
  if (p.startsWith('/api/')) {
    let g;
    if (p === '/api/login' && method === 'POST') {
      const raw = await readRaw(req); let b = {}; try { b = JSON.parse(raw.toString() || '{}'); } catch {}
      if (String(b.email || '').toLowerCase() === LOGIN_EMAIL && b.password === LOGIN_PASSWORD)
        return sendJSON(res, { ok: true, user: { id: 'u1', name: 'Administrador', role: 'admin', numbers: NUMBERS.map((n) => n.id) } });
      return sendJSON(res, { ok: false, error: 'credenciais' }, 401);
    }
    if (p === '/api/numbers') return sendJSON(res, NUMBERS.map((n) => ({ id: n.id, name: n.name, phone: n.phone, type: n.type || 'comercial', status: n.status })));
    if (p === '/api/team') return sendJSON(res, [{ id: 'u1', name: 'Administrador', email: LOGIN_EMAIL, role: 'admin', numbers: NUMBERS.map((n) => n.id), active: true }]);
    if (p === '/api/config') return sendJSON(res, { maxNumbers: 3, connected: NUMBERS.length, webhookUrl: `${url.protocol}//${req.headers.host}/webhook`, wabaId: process.env.WABA_ID || '—', appId: process.env.APP_ID || '—', retentionDays: 90 });
    if ((g = p.match(/^\/api\/numbers\/([^/]+)\/conversations$/))) return sendJSON(res, listConversations(g[1], url.searchParams.get('folder') || 'conversas', url.searchParams.get('q') || ''));
    if ((g = p.match(/^\/api\/numbers\/([^/]+)\/conversations\/([^/]+)\/messages$/))) {
      const s = store[g[1]]; const conv = s && s.convs.get(g[2]); if (conv) conv.unread = 0;
      return sendJSON(res, conv ? conv.messages : []);
    }
    if ((g = p.match(/^\/api\/numbers\/([^/]+)\/deleted$/))) return sendJSON(res, []); // Cloud API não notifica exclusões
    if ((g = p.match(/^\/api\/numbers\/([^/]+)\/media$/))) return sendJSON(res, listMedia(g[1], url.searchParams.get('kind') || 'midias'));
    if ((g = p.match(/^\/api\/numbers\/([^/]+)\/stream$/))) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('event: ready\ndata: {}\n\n');
      return subscribe(g[1], res);
    }
    // Fluxo de conexão (código interno) — mantém o painel funcional
    if (p === '/api/connect/start' && method === 'POST') {
      const raw = await readRaw(req); let b = {}; try { b = JSON.parse(raw.toString() || '{}'); } catch {}
      const t = newToken(); CONNECT.set(t, { code: gen6(), label: b.label || 'Novo número', expiresAt: Date.now() + 600000, attempts: 0, status: 'pendente' });
      return sendJSON(res, { token: t, expiresAt: CONNECT.get(t).expiresAt });
    }
    if ((g = p.match(/^\/api\/connect\/([^/]+)$/)) && method === 'GET') {
      const s = CONNECT.get(g[1]); if (!s) return sendJSON(res, { status: 'invalido' });
      if (s.status === 'pendente' && Date.now() > s.expiresAt) s.status = 'expirado';
      return sendJSON(res, { status: s.status, code: s.code, label: s.label, expiresAt: s.expiresAt, attemptsLeft: 5 - s.attempts });
    }
    if ((g = p.match(/^\/api\/connect\/([^/]+)\/verify$/)) && method === 'POST') {
      const raw = await readRaw(req); let b = {}; try { b = JSON.parse(raw.toString() || '{}'); } catch {}
      const s = CONNECT.get(g[1]); if (!s) return sendJSON(res, { status: 'invalido' });
      if (Date.now() > s.expiresAt) { s.status = 'expirado'; return sendJSON(res, { status: 'expirado' }); }
      if (String(b.code) === s.code) { s.status = 'concluido'; return sendJSON(res, { status: 'ok' }); }
      s.attempts++; return sendJSON(res, { status: 'errado', remaining: 5 - s.attempts });
    }
    if ((g = p.match(/^\/api\/numbers\/([^/]+)\/test$/)) && method === 'POST') {
      return sendJSON(res, { ok: true, checks: [
        { step: 'Token da Cloud API', ok: !!WHATSAPP_TOKEN },
        { step: 'Número configurado (WA_NUMBERS)', ok: NUMBERS.length > 0 },
        { step: 'Assinatura do webhook (APP_SECRET)', ok: !!APP_SECRET },
      ] });
    }
    return sendJSON(res, { error: 'not_found' }, 404);
  }

  // ---- Estáticos (painel) ----
  serveStatic(res, p);
});

server.listen(PORT, () => {
  console.log(`Backend WhatsApp (somente leitura) em http://localhost:${PORT}`);
  console.log(`Números configurados: ${NUMBERS.length ? NUMBERS.map((n) => `${n.id} (${n.phone_number_id})`).join(', ') : 'NENHUM — defina WA_NUMBERS'}`);
  console.log(`Webhook: GET/POST /webhook · VERIFY_TOKEN ${VERIFY_TOKEN === 'verifique-me' ? '(padrão — troque!)' : 'definido'}`);
});

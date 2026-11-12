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
const COEXY_HMAC_SECRET = process.env.COEXY_HMAC_SECRET || process.env.COEXY_SECRET || ''; // segredo do webhook do Coexy (X-Coexy-Signature)
const COEXY_PROXY_BASE = 'https://api.coexy.com.br/functions/v1/meta-proxy'; // download de mídia via Coexy
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
NUMBERS.forEach((n) => { store[n.id] = { convs: new Map(), seen: new Set() }; });
// Deduplicação: o Coexy pode reentregar o mesmo evento (retries). Ignora wamid repetido.
function seenBefore(numberId, wamid) {
  const s = store[numberId]; if (!s || !wamid) return false;
  if (s.seen.has(wamid)) return true;
  s.seen.add(wamid);
  if (s.seen.size > 5000) s.seen.delete(s.seen.values().next().value);
  return false;
}

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

const mediaUrlFor = (numberId, id) => (id ? '/api/media/' + encodeURIComponent(numberId) + '/' + encodeURIComponent(id) : undefined);
// Converte uma mensagem da Cloud API para o formato da UI.
function toUiMessage(msg, dir, numberId) {
  const base = { id: msg.id, dir, time: hhmm(msg.timestamp), day: dayLabel(msg.timestamp) };
  const mu = (id) => mediaUrlFor(numberId, id);
  switch (msg.type) {
    case 'text': return Object.assign(base, { type: 'text', text: msg.text && msg.text.body });
    case 'image': { const id = msg.image && msg.image.id; return Object.assign(base, { type: 'image', media: '🖼️', text: (msg.image && msg.image.caption) || '', mediaId: id, mediaUrl: mu(id) }); }
    case 'video': { const id = msg.video && msg.video.id; return Object.assign(base, { type: 'video', media: '🎥', text: (msg.video && msg.video.caption) || '', mediaId: id, mediaUrl: mu(id) }); }
    case 'audio': { const id = msg.audio && msg.audio.id; return Object.assign(base, { type: 'audio', text: 'Áudio', mediaId: id, mediaUrl: mu(id) }); }
    case 'sticker': { const id = msg.sticker && msg.sticker.id; return Object.assign(base, { type: 'sticker', media: '🧩', mediaId: id, mediaUrl: mu(id) }); }
    case 'document': { const id = msg.document && msg.document.id; return Object.assign(base, { type: 'doc', text: (msg.document && (msg.document.filename || 'Documento')), mediaId: id, mediaUrl: mu(id) }); }
    default: return Object.assign(base, { type: 'text', text: '[' + msg.type + ']' });
  }
}

/* ------------------------- DOWNLOAD DE MÍDIA --------------------------- *
 * A Cloud API entrega mídia por ID: GET /{id} dá uma URL temporária, que
 * baixamos com o mesmo token. Fazemos cache em memória para não rebaixar.
 * ----------------------------------------------------------------------- */
const GRAPH_VERSION = 'v21.0';
function httpsGet(targetUrl, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, { headers: token ? { Authorization: 'Bearer ' + token } : {} }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}
const mediaCache = new Map(); // "numberId:id" -> { buf, mime }
// Baixa a mídia: Coexy (channel_token no proxy) ou Meta direto (WHATSAPP_TOKEN na Graph).
async function fetchMedia(number, id) {
  const key = (number ? number.id : '-') + ':' + id;
  if (mediaCache.has(key)) return mediaCache.get(key);
  let base, token;
  if (number && number.channel_token) { base = COEXY_PROXY_BASE; token = number.channel_token; }
  else { base = `https://graph.facebook.com/${GRAPH_VERSION}`; token = WHATSAPP_TOKEN; }
  if (!token) throw new Error('sem token de mídia (channel_token ou WHATSAPP_TOKEN)');
  const meta = await httpsGet(`${base}/${encodeURIComponent(id)}`, token);
  if (meta.status !== 200) throw new Error('metadados HTTP ' + meta.status);
  const info = JSON.parse(meta.body.toString('utf8'));
  if (!info.url) throw new Error('sem url de mídia');
  const bin = await httpsGet(info.url, token); // mesmo Bearer, conforme spec
  if (bin.status !== 200) throw new Error('download HTTP ' + bin.status);
  const out = { buf: bin.body, mime: info.mime_type || bin.headers['content-type'] || 'application/octet-stream' };
  mediaCache.set(key, out);
  if (mediaCache.size > 200) mediaCache.delete(mediaCache.keys().next().value);
  return out;
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
        if (seenBefore(number.id, msg.id)) continue;
        const waId = msg.from;
        const conv = ensureConv(number.id, waId, contacts[waId]);
        const ui = toUiMessage(msg, 'in', number.id);
        conv.messages.push(ui);
        conv.unread = (conv.unread || 0) + 1;
        broadcast(number.id, 'message', { convId: conv.id, message: ui, unread: conv.unread });
        console.log(`[${number.id}] recebida de ${conv.name}: ${ui.text || ui.type}`);
      }
      // Ecos (mensagens enviadas pelo próprio número — coexistência)
      for (const msg of (value.message_echoes || value.smb_message_echoes || [])) {
        if (seenBefore(number.id, msg.id)) continue;
        const waId = msg.to || msg.recipient_id;
        const conv = ensureConv(number.id, waId, contacts[waId]);
        const ui = toUiMessage(msg, 'out', number.id);
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
  const out = [];
  for (const c of s.convs.values()) for (const m of c.messages) {
    const inMidias = kind === 'midias' && (m.type === 'image' || m.type === 'video');
    const inFig = kind === 'figurinhas' && m.type === 'sticker';
    if (inMidias || inFig) {
      out.push({ media: m.media || '🖼️', kind: m.type === 'video' ? 'video' : 'image', contact: c.name, dir: m.dir, time: m.time, mediaUrl: m.mediaUrl });
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
const hmacHex = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
// Aceita tanto a assinatura da Meta (X-Hub-Signature-256) quanto a do Coexy (X-Coexy-Signature).
function checkWebhookSignature(req, raw) {
  const metaSig = req.headers['x-hub-signature-256'];
  const coexySig = req.headers['x-coexy-signature'];
  if (metaSig) {
    if (!APP_SECRET) return true; // modo teste
    const expected = 'sha256=' + hmacHex(APP_SECRET, raw);
    try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(metaSig)); } catch { return false; }
  }
  if (coexySig) {
    if (!COEXY_HMAC_SECRET) return true; // modo teste
    const hex = hmacHex(COEXY_HMAC_SECRET, raw);
    return coexySig === 'sha256=' + hex || coexySig === hex; // Coexy usa "sha256=<hex>"
  }
  // Sem assinatura: só aceita se nenhum segredo estiver configurado (modo teste)
  return !APP_SECRET && !COEXY_HMAC_SECRET;
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
    if (!checkWebhookSignature(req, raw)) { res.writeHead(401); return res.end('invalid signature'); }
    res.writeHead(200); res.end('EVENT_RECEIVED'); // responde antes de processar (regra do Coexy: < 10s)
    let body = {}; try { body = JSON.parse(raw.toString('utf8')); } catch {}
    try { handleWebhook(body); } catch (e) { console.error('Erro no webhook:', e); }
    return;
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
    if ((g = p.match(/^\/api\/media\/([^/]+)\/(.+)$/)) && method === 'GET') {
      const num = NUMBERS.find((n) => n.id === g[1]);
      try {
        const md = await fetchMedia(num, decodeURIComponent(g[2]));
        res.writeHead(200, { 'Content-Type': md.mime, 'Cache-Control': 'private, max-age=3600' });
        return res.end(md.buf);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Falha ao obter mídia: ' + e.message);
      }
    }
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

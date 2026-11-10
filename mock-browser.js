/* =========================================================================
 * Mock no navegador (para a versão estática / GitHub Pages).
 * Intercepta window.fetch e window.EventSource para responder /api/* sem
 * backend. A UL (app.js, admin.js, connect.html) não muda nada.
 * ========================================================================= */
(function () {
  const m = (o) => Object.assign({ dir: 'in', type: 'text', day: 'Hoje' }, o);

  const NUMBERS = [
    { id: 'n1', name: 'Atendimento Comercial', phone: '+55 11 90000-0001', type: 'comercial', status: 'conectado' },
    { id: 'n2', name: 'João (pessoal)',        phone: '+55 11 90000-0002', type: 'pessoal',   status: 'conectado' },
  ];

  const CONVERSATIONS = {
    n1: [
      { id: 'c1', name: 'Maria Silva', phone: '+55 11 98888-1111', locked: false, unread: 2, messages: [
        m({ id: 'm1', dir: 'in',  text: 'Bom dia! Vocês têm o produto X em estoque?', time: '09:12', day: 'Ontem' }),
        m({ id: 'm2', dir: 'out', text: 'Bom dia, Maria! Temos sim. Quer que eu reserve?', time: '09:15', day: 'Ontem' }),
        m({ id: 'm3', dir: 'in',  type: 'image', media: '🖼️', text: 'É esse modelo mesmo?', time: '09:20', day: 'Ontem' }),
        m({ id: 'm4', dir: 'out', text: 'Isso! Esse está com 10% de desconto hoje.', time: '09:21', day: 'Ontem' }),
        m({ id: 'm5', dir: 'in',  text: 'Perfeito, vou querer.', time: '08:40', day: 'Hoje' }),
        m({ id: 'm6', dir: 'in',  type: 'deleted', deletedAt: '08:41', text: 'Na verdade manda dois', time: '08:41', day: 'Hoje' }),
        m({ id: 'm7', dir: 'in',  text: 'Quanto fica o frete pro CEP 01000-000?', time: '08:42', day: 'Hoje' }),
      ]},
      { id: 'c2', name: 'Carlos Pereira', phone: '+55 11 97777-2222', locked: true, unread: 0, messages: [
        m({ id: 'm1', dir: 'in',  text: 'Preciso de uma segunda via da nota fiscal.', time: '14:02', day: 'Ontem' }),
        m({ id: 'm2', dir: 'out', type: 'doc', text: 'nota-fiscal-4471.pdf', time: '14:30', day: 'Ontem' }),
        m({ id: 'm3', dir: 'in',  text: 'Recebido, obrigado!', time: '14:33', day: 'Ontem' }),
      ]},
      { id: 'c3', name: 'Grupo — Vendas SP', phone: 'Grupo · 8 participantes', locked: false, unread: 5, messages: [
        m({ id: 'm1', dir: 'in',  sender: 'Ana', text: 'Fechamos o pedido da rede de farmácias 🎉', time: '11:00', day: 'Hoje' }),
        m({ id: 'm2', dir: 'in',  sender: 'Rafael', type: 'sticker', media: '🎉', time: '11:01', day: 'Hoje' }),
        m({ id: 'm3', dir: 'in',  sender: 'Beatriz', text: 'Parabéns time!', time: '11:02', day: 'Hoje' }),
        m({ id: 'm4', dir: 'out', text: 'Excelente! Vou preparar a proposta de recorrência.', time: '11:05', day: 'Hoje' }),
      ]},
    ],
    n2: [
      { id: 'c1', name: 'Mãe ❤️', phone: '+55 11 94444-5555', locked: false, unread: 0, messages: [
        m({ id: 'm1', dir: 'in',  type: 'gif', media: '🎞️', text: 'GIF: bom dia', time: '07:30', day: 'Hoje' }),
        m({ id: 'm2', dir: 'out', text: 'Bom dia, mãe! Já tô indo trabalhar.', time: '07:35', day: 'Hoje' }),
      ]},
      { id: 'c2', name: 'Oficina do Pedro', phone: '+55 11 95555-4444', locked: true, unread: 0, messages: [
        m({ id: 'm1', dir: 'in', text: 'Seu carro fica pronto amanhã às 10h.', time: '17:45', day: 'Ontem' }),
        m({ id: 'm2', dir: 'in', type: 'deleted', deletedAt: '17:46', text: 'Na verdade só quinta', time: '17:46', day: 'Ontem' }),
      ]},
    ],
  };

  const MEDIA = {
    midias: ['🏞️','🌆','📦','🧾','🖼️','📸','🏔️','🌅','🍕'],
    figurinhas: ['🎉','😂','👍','❤️','🔥','🙏','😎','🥳','🤝','💯','🚀','✨'],
    gifs: ['🎞️','📺','🎬','🕺','💃','🐱'],
  };

  const TEAM = [
    { id: 'u1', name: 'Ana Admin',     email: 'ana@empresa.com',   role: 'admin',        numbers: ['n1','n2'], active: true },
    { id: 'u2', name: 'Bruno Vendas',  email: 'bruno@empresa.com', role: 'visualizador', numbers: ['n1'],      active: true },
    { id: 'u3', name: 'Carla Suporte', email: 'carla@empresa.com', role: 'visualizador', numbers: ['n2'],      active: false },
  ];

  const MAX_NUMBERS = 3;
  // Estado compartilhado entre abas (o link de conexão abre em outra aba).
  const LS_CONNECT = 'wa_connect', LS_EXTRA = 'wa_extra_numbers';
  const lsRead = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || d); } catch { return JSON.parse(d); } };
  const lsWrite = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const connGet = (t) => lsRead(LS_CONNECT, '{}')[t] || null;
  const connPut = (t, s) => { const a = lsRead(LS_CONNECT, '{}'); a[t] = s; lsWrite(LS_CONNECT, a); };
  (lsRead(LS_EXTRA, '[]')).forEach((n) => { if (!NUMBERS.some(x => x.id === n.id)) NUMBERS.push(n); });
  function addConnectedNumber(s) {
    const id = 'n' + (NUMBERS.length + 1);
    const num = { id, name: (s && s.label) || 'Novo número', phone: (s && s.phone) || '+55 11 90000-0000', type: (s && s.type) || 'comercial', status: 'conectado' };
    NUMBERS.push(num);
    const extra = lsRead(LS_EXTRA, '[]'); extra.push(num); lsWrite(LS_EXTRA, extra);
    return num;
  }
  const TTL = 10 * 60 * 1000, MAX_ATTEMPTS = 5;
  const gen6 = () => String(Math.floor(100000 + Math.random() * 900000));
  const newToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const nowHHMM = () => { const d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); };

  function convSummary(c) {
    const last = c.messages[c.messages.length - 1];
    return { id: c.id, name: c.name, phone: c.phone, locked: c.locked, unread: c.unread,
      last: last ? { type: last.type, text: last.text, time: last.time } : null };
  }
  function listConversations(id, folder, q) {
    let list = (CONVERSATIONS[id] || []);
    if (folder === 'trancadas') list = list.filter(c => c.locked);
    if (q) { const s = q.toLowerCase(); list = list.filter(c => c.name.toLowerCase().includes(s) || c.messages.some(x => (x.text || '').toLowerCase().includes(s))); }
    return list.map(convSummary);
  }
  function listDeleted(id) {
    const out = [];
    for (const c of (CONVERSATIONS[id] || [])) for (const x of c.messages) if (x.type === 'deleted') out.push({ convId: c.id, conv: c.name, when: x.deletedAt, text: x.text, dir: x.dir });
    return out;
  }
  function connectState(t) {
    const s = connGet(t); if (!s) return { status: 'invalido' };
    if (s.status === 'pendente' && Date.now() > s.expiresAt) { s.status = 'expirado'; connPut(t, s); }
    return { status: s.status, code: s.code, label: s.label, expiresAt: s.expiresAt, attemptsLeft: MAX_ATTEMPTS - s.attempts };
  }

  /* --------------------------- Router (fetch) --------------------------- */
  function route(method, path, qs, body) {
    let g;
    if (path === '/api/login' && method === 'POST') {
      const u = TEAM.find(x => x.email.toLowerCase() === String(body.email || '').toLowerCase() && x.active);
      if (u && body.password === 'teste123') return [200, { ok: true, user: { id: u.id, name: u.name, role: u.role, numbers: u.numbers } }];
      return [401, { ok: false, error: 'credenciais' }];
    }
    if (path === '/api/numbers') return [200, NUMBERS];
    if (path === '/api/team') return [200, TEAM];
    if (path === '/api/config') return [200, { maxNumbers: MAX_NUMBERS, connected: NUMBERS.length, webhookUrl: 'https://gerenciador.suaempresa.com/webhook', wabaId: '•••• 4821', appId: '•••• 3390', retentionDays: 90 }];

    if ((g = path.match(/^\/api\/numbers\/([^/]+)\/conversations$/))) return [200, listConversations(g[1], qs.get('folder') || 'conversas', qs.get('q') || '')];
    if ((g = path.match(/^\/api\/numbers\/([^/]+)\/conversations\/([^/]+)\/messages$/))) {
      const conv = (CONVERSATIONS[g[1]] || []).find(c => c.id === g[2]); if (conv) conv.unread = 0;
      return [200, conv ? conv.messages : []];
    }
    if ((g = path.match(/^\/api\/numbers\/([^/]+)\/deleted$/))) return [200, listDeleted(g[1])];
    if ((g = path.match(/^\/api\/numbers\/([^/]+)\/media$/))) return [200, MEDIA[qs.get('kind') || 'midias'] || []];
    if ((g = path.match(/^\/api\/numbers\/([^/]+)\/test$/)) && method === 'POST')
      return [200, { ok: true, checks: [{ step: 'Credenciais WABA', ok: true }, { step: 'Assinatura do webhook', ok: true }, { step: 'Evento de teste recebido', ok: true }] }];

    if (path === '/api/connect/start' && method === 'POST') {
      if (NUMBERS.length >= MAX_NUMBERS) return [409, { error: 'limite_atingido', max: MAX_NUMBERS }];
      const t = newToken(); connPut(t, { code: gen6(), label: body.label || 'Novo número', phone: body.phone || '', type: body.type || 'comercial', expiresAt: Date.now() + TTL, attempts: 0, status: 'pendente' });
      return [200, { token: t, expiresAt: connGet(t).expiresAt }];
    }
    if ((g = path.match(/^\/api\/connect\/([^/]+)$/)) && method === 'GET') return [200, connectState(g[1])];
    if ((g = path.match(/^\/api\/connect\/([^/]+)\/verify$/)) && method === 'POST') {
      const s = connGet(g[1]);
      if (!s) return [200, { status: 'invalido' }];
      if (s.status === 'concluido') return [200, { status: 'concluido' }];
      if (Date.now() > s.expiresAt) { s.status = 'expirado'; connPut(g[1], s); return [200, { status: 'expirado' }]; }
      if (s.attempts >= MAX_ATTEMPTS) { s.status = 'bloqueado'; connPut(g[1], s); return [200, { status: 'bloqueado' }]; }
      if (String(body.code) === s.code) { s.status = 'concluido'; connPut(g[1], s); addConnectedNumber(s); return [200, { status: 'ok' }]; }
      s.attempts++; connPut(g[1], s); return [200, { status: 'errado', remaining: MAX_ATTEMPTS - s.attempts }];
    }
    if ((g = path.match(/^\/api\/connect\/([^/]+)\/renew$/)) && method === 'POST') {
      const s = connGet(g[1]); if (!s) return [404, { error: 'invalido' }];
      s.code = gen6(); s.expiresAt = Date.now() + TTL; s.attempts = 0; s.status = 'pendente'; connPut(g[1], s);
      return [200, { token: g[1], code: s.code, expiresAt: s.expiresAt }];
    }
    return [404, { error: 'not_found' }];
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url || !url.includes('/api/')) return realFetch(input, init);
    const u = new URL(url, location.origin);
    const method = (init && init.method ? init.method : 'GET').toUpperCase();
    let body = {}; try { if (init && init.body) body = JSON.parse(init.body); } catch {}
    const [status, data] = route(method, u.pathname, u.searchParams, body);
    return Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
  };

  /* ----------------------- EventSource (SSE) mock ----------------------- */
  const DEMO = [
    { patch: { dir: 'in', text: 'Esse protótipo atualiza em tempo real 🙂' } },
    { patch: { dir: 'in', type: 'sticker', media: '👍' } },
  ];
  class MockEventSource {
    constructor(url) {
      this.listeners = {}; this.onerror = null;
      const g = String(url).match(/^\/api\/numbers\/([^/]+)\/stream$/);
      this.numberId = g ? g[1] : null;
      setTimeout(() => this._emit('ready', '{}'), 0);
      let i = 0;
      this.timer = setInterval(() => {
        if (this.numberId !== 'n1') return;
        const d = DEMO[i % DEMO.length]; i++;
        const conv = (CONVERSATIONS.n1 || []).find(c => c.id === 'c1'); if (!conv) return;
        const msg = m(Object.assign({ id: 'live' + Date.now(), time: nowHHMM(), day: 'Hoje' }, d.patch));
        conv.messages.push(msg); conv.unread = (conv.unread || 0) + 1;
        this._emit('message', JSON.stringify({ convId: 'c1', message: msg, unread: conv.unread }));
      }, 12000);
    }
    addEventListener(type, cb) { (this.listeners[type] = this.listeners[type] || []).push(cb); }
    _emit(type, data) { (this.listeners[type] || []).forEach(cb => cb({ data })); }
    close() { clearInterval(this.timer); }
  }
  window.EventSource = MockEventSource;
})();

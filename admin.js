/* =========================================================================
 * Administração — números (até 3), equipe, conexão & teste.
 * Reutiliza helpers `el` e `esc` definidos em app.js (mesma página).
 * Consome os endpoints de admin do mock-server.
 * ========================================================================= */
(function () {
  const overlay = document.getElementById('adminOverlay');
  const body = document.getElementById('adminBody');
  const tabs = document.getElementById('adminTabs');
  let active = 'numeros';

  const get = (u) => fetch(u).then(r => r.json());
  const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());

  function open() { overlay.hidden = false; render(); }
  function close() { overlay.hidden = true; }

  document.getElementById('adminClose').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tabs__btn'); if (!b) return;
    active = b.dataset.tab;
    [...tabs.children].forEach(x => x.classList.toggle('is-active', x === b));
    render();
  });

  async function render() {
    body.innerHTML = '<div class="admin-note">Carregando…</div>';
    if (active === 'numeros') return renderNumeros();
    if (active === 'equipe') return renderEquipe();
    if (active === 'conexao') return renderConexao();
  }

  /* ------------------------------ Números ------------------------------- */
  async function renderNumeros() {
    const [nums, cfg] = await Promise.all([get('/api/numbers'), get('/api/config')]);
    body.innerHTML = '';
    const canAdd = nums.length < cfg.maxNumbers;
    body.appendChild(el('div', 'admin-note', `${nums.length} de ${cfg.maxNumbers} números conectados.`));

    for (const n of nums) {
      const row = el('div', 'admin-row');
      const av = el('div', 'avatar', initials(n.name)); av.style.background = colorFor(n.name); av.style.width = '40px'; av.style.height = '40px'; av.style.fontSize = '15px';
      row.appendChild(av);
      row.appendChild(el('div', 'admin-row__main', `
        <div class="admin-row__title">${esc(n.name)} <span class="pill pill--${n.type}">${n.type}</span></div>
        <div class="admin-row__sub">${esc(n.phone)} · <span class="status status--${n.status}">${n.status}</span></div>`));
      const actions = el('div', 'admin-row__actions');
      const reconnect = el('button', 'btn btn--ghost', 'Reconectar');
      reconnect.onclick = () => alert(`Reconectar ${n.name} (mock): reabriria o fluxo de conexão.`);
      const remove = el('button', 'btn btn--danger', 'Remover');
      remove.onclick = () => alert(`Remover ${n.name} (mock): encerraria o espelhamento deste número.`);
      actions.append(reconnect, remove);
      row.appendChild(actions);
      body.appendChild(row);
    }

    const add = el('button', 'btn btn--primary', '+ Conectar número');
    add.disabled = !canAdd;
    add.style.marginTop = '6px';
    add.onclick = () => startConnectFlow(cfg);
    body.appendChild(add);
    if (!canAdd) body.appendChild(el('div', 'admin-note', `Limite de ${cfg.maxNumbers} números atingido. Remova um para conectar outro.`));

    const slot = el('div'); slot.id = 'connectSlot'; body.appendChild(slot);
  }

  function startConnectFlow(cfg) {
    const slot = document.getElementById('connectSlot');
    slot.innerHTML = `
      <div class="admin-note" style="margin-top:4px"><strong>Conectar novo número</strong> (com consentimento do responsável):</div>
      <div class="connform__grid">
        <div class="field"><label>País</label><input id="cfDDI" value="+55" /></div>
        <div class="field"><label>DDD</label><input id="cfDDD" placeholder="11" /></div>
        <div class="field"><label>Número</label><input id="cfNum" placeholder="90000-0000" /></div>
      </div>
      <div class="field"><label>Nome / rótulo</label><input id="cfName" placeholder="Ex.: Vendas Zona Sul" /></div>
      <div class="field"><label>Tipo</label>
        <select id="cfType"><option value="comercial">Comercial</option><option value="pessoal">Pessoal (com consentimento)</option></select>
      </div>
      <div class="admin-note" style="margin-top:6px">Canal de disparo do link (ao responsável):</div>
      <div class="chips" id="chanChips">
        <button type="button" class="chip is-active" data-ch="email">✉️ E-mail</button>
        <button type="button" class="chip" data-ch="sms">💬 SMS</button>
        <button type="button" class="chip" data-ch="qr">🔳 QR no painel</button>
      </div>
      <button class="btn btn--primary" id="cfSend">Enviar link</button>
      <div id="connResult"></div>`;
    let channel = 'email';
    slot.querySelectorAll('#chanChips .chip').forEach(b => b.onclick = () => {
      channel = b.dataset.ch;
      slot.querySelectorAll('#chanChips .chip').forEach(x => x.classList.toggle('is-active', x === b));
    });
    document.getElementById('cfSend').onclick = () => sendConnectLink(channel);
  }

  const val = (id) => (document.getElementById(id).value || '').trim();

  async function sendConnectLink(channel) {
    const ddi = val('cfDDI'), ddd = val('cfDDD'), num = val('cfNum'), name = val('cfName'), type = val('cfType');
    const box = document.getElementById('connResult');
    if (!ddd || !num) { box.innerHTML = '<div class="admin-note" style="color:var(--danger)">Informe DDD e número.</div>'; return; }
    const phone = `${ddi} ${ddd} ${num}`.replace(/\s+/g, ' ').trim();
    const r = await post('/api/connect/start', { label: name || phone, phone, type });
    if (r.error === 'limite_atingido') { box.innerHTML = `<div class="admin-note">Limite de ${r.max} números atingido.</div>`; return; }
    const link = new URL(`connect.html?t=${r.token}`, location.href).href;
    const chan = channel === 'sms' ? `SMS para ${esc(phone)}` : channel === 'qr' ? 'QR no painel' : 'e-mail ao responsável';
    box.innerHTML = `
      <div class="admin-note" style="margin-top:12px">✅ Link enviado (${chan}, simulado). Peça ao responsável para abrir o link e ler o <strong>código de confirmação</strong>.</div>
      <button class="btn btn--ghost" id="cfOpen" style="margin:8px 0">Abrir página de conexão (visão do responsável)</button>
      <div class="field"><label>Digite o código que o responsável informou</label><input id="cfCode" inputmode="numeric" maxlength="6" placeholder="6 dígitos" /></div>
      <button class="btn btn--primary" id="cfConnect">Conectar</button>
      <div id="cfMsg" class="admin-note"></div>`;
    document.getElementById('cfOpen').onclick = () => window.open(link, '_blank');
    document.getElementById('cfConnect').onclick = async () => {
      const code = val('cfCode');
      const v = await post(`/api/connect/${r.token}/verify`, { code });
      const msg = document.getElementById('cfMsg');
      if (v.status === 'ok') {
        msg.innerHTML = '✅ Número conectado! Atualizando a lista…';
        if (window.AppRefreshNumbers) window.AppRefreshNumbers();
        setTimeout(() => renderNumeros(), 800);
        return;
      }
      if (v.status === 'expirado') { msg.textContent = 'Código/link expirado. Envie um novo link.'; return; }
      if (v.status === 'bloqueado') { msg.textContent = 'Muitas tentativas. Envie um novo link.'; return; }
      msg.textContent = `Código incorreto. Tentativas restantes: ${v.remaining ?? 0}.`;
    };
  }

  /* ------------------------------- Equipe ------------------------------- */
  async function renderEquipe() {
    const [team, nums] = await Promise.all([get('/api/team'), get('/api/numbers')]);
    const nameOf = (id) => (nums.find(n => n.id === id) || {}).name || id;
    body.innerHTML = '';
    body.appendChild(el('div', 'admin-note', 'Administrador gere tudo; Visualizador apenas lê as conversas dos números atribuídos.'));
    for (const u of team) {
      const row = el('div', 'admin-row');
      const av = el('div', 'avatar', initials(u.name)); av.style.background = colorFor(u.name); av.style.width = '40px'; av.style.height = '40px'; av.style.fontSize = '15px';
      row.appendChild(av);
      row.appendChild(el('div', 'admin-row__main', `
        <div class="admin-row__title">${esc(u.name)} <span class="role role--${u.role}">${u.role}</span></div>
        <div class="admin-row__sub">${esc(u.email)} · números: ${u.numbers.map(nameOf).map(esc).join(', ')} ${u.active ? '' : '· <span class="status status--erro">inativo</span>'}</div>`));
      const actions = el('div', 'admin-row__actions');
      const toggle = el('button', 'btn btn--ghost', u.active ? 'Desativar' : 'Ativar');
      toggle.onclick = () => alert(`${u.active ? 'Desativar' : 'Ativar'} ${u.name} (mock).`);
      actions.appendChild(toggle);
      row.appendChild(actions);
      body.appendChild(row);
    }
    const invite = el('button', 'btn btn--primary', '+ Convidar usuário');
    invite.style.marginTop = '6px';
    invite.onclick = () => alert('Convidar usuário (mock): enviaria convite por e-mail com papel e números.');
    body.appendChild(invite);
  }

  /* --------------------------- Conexão & Teste -------------------------- */
  async function renderConexao() {
    const cfg = await get('/api/config');
    body.innerHTML = `
      <div class="field"><label>URL do webhook (recebe eventos da Meta)</label><input value="${esc(cfg.webhookUrl)}" readonly /></div>
      <div class="field"><label>WABA ID</label><input value="${esc(cfg.wabaId)}" readonly /></div>
      <div class="field"><label>App ID</label><input value="${esc(cfg.appId)}" readonly /></div>
      <div class="field"><label>Retenção (dias)</label><input value="${esc(String(cfg.retentionDays))}" readonly /></div>`;
    const testBtn = el('button', 'btn btn--primary', 'Testar conexão');
    const result = el('div');
    testBtn.onclick = async () => {
      testBtn.disabled = true; result.innerHTML = '<div class="admin-note">Testando…</div>';
      const r = await post('/api/numbers/n1/test');
      result.innerHTML = '';
      const ul = el('ul', 'checklist');
      for (const c of r.checks) ul.appendChild(el('li', '', `${c.ok ? '✅' : '❌'} ${esc(c.step)}`));
      result.appendChild(ul);
      result.appendChild(el('div', 'admin-note', r.ok ? 'Conexão validada com sucesso (mock).' : 'Falha no teste.'));
      testBtn.disabled = false;
    };
    body.append(testBtn, result);
    body.appendChild(el('div', 'admin-note', 'Credenciais mascaradas por segurança. No backend real ficam em cofre de segredos, nunca no front.'));
  }

  window.AdminUI = { open, close };
})();

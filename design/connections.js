/* Connections view: one card per coding agent. Not installed → Install → Sign in → Connected.
   Behind each button the real app runs the provider's official installer and login. */

const CONN = {
  claude: { state: 'connected', version: '2.3.14', account: 'Claude Max plan', chats: 29, home: '~/.claude', showChats: true, suggest: true,
    login: 'claude auth login', note: 'Runs Claude Code on this computer with your own sign-in. Anthropic’s rules for using a subscription in other apps changed several times in 2026, so check their current terms.' },
  codex: { state: 'connected', version: '0.156.1', account: 'Signed in with ChatGPT · Plus', chats: 69, home: '~/.codex', showChats: true, suggest: true, login: 'codex login', note: '' },
  antigravity: { state: 'connected', version: '1.1.11', account: 'Google account · Pro', chats: 37, home: '~/.gemini/antigravity', showChats: true, suggest: true, login: 'Sign in with Google',
    note: 'Usage limits show only when Antigravity reports them itself.', update: '1.1.12' },
};
const LATER = [
  { name: 'OpenCode', tile: 'O', badge: ['free', 'Free models'], text: 'Open-source agent that can run free and local models.' },
  { name: 'Qwen Code', tile: 'Q', badge: ['free', 'Free tier'], text: 'Free daily allowance with a Qwen account. Limits vary.' },
  { name: 'Cursor CLI', tile: 'C', badge: ['quiet', 'Your Cursor plan'], text: 'Cursor’s agent in the terminal, on your existing plan.' },
  { name: 'GitHub Copilot CLI', tile: 'G', badge: ['quiet', 'Your Copilot plan'], text: 'Copilot’s agent, on your existing GitHub plan.' },
];
const notifyMe = new Set();
let connFailNext = false;

const STATE_LABEL = { connected: 'Connected', missing: 'Not installed', installing: 'Installing', signedout: 'Signed out', signin: 'Waiting for sign-in', error: 'Needs attention' };

function renderConnections() {
  const page = document.getElementById('connPage');
  const connected = PIDS.filter(id => CONN[id].state === 'connected').length;
  page.innerHTML = `<div class="page-inner">
    <div class="page-head"><div class="t"><h1>Connections</h1>
      <p>Agent Kanban uses the agent apps on this computer. Your sign-in stays inside each app; we never see your password or tokens.</p></div>
      <span class="source"><span class="live-dot"></span>${connected} of ${PIDS.length} connected</span></div>
    <h2 class="section-title">Coding agents</h2>
    <div class="conn-grid">${PIDS.map(connCard).join('')}</div>
    <h2 class="section-title">More agents, coming later <span class="r" style="color:var(--color-text-faint);font-size:var(--text-caption)">Including free ones</span></h2>
    <div class="conn-grid">${LATER.map(laterCard).join('')}
      <div class="conn later"><div class="conn-head"><span class="logo-tile">${icon('plus')}</span><div class="t"><b>Something else?</b><small>Tell us which agent you use</small></div></div>
        <div class="conn-body"><label class="search" style="width:100%"><input id="reqInput" name="agent-request" autocomplete="off" placeholder="For example: Amp, Goose, Aider…" aria-label="Agent name" style="width:100%"></label></div>
        <div class="conn-foot"><span class="grow"></span><button class="btn" type="button" id="reqBtn">Request</button></div></div>
    </div>
    <div class="demo-bar">Prototype only:
      <button class="link-btn" type="button" id="demoSetup">Replay setup for Codex</button>
      <button class="link-btn" type="button" id="demoFail">Show a failed sign-in for Antigravity</button></div>
  </div>`;
  const view = document.getElementById('viewConnections');
  view.classList.remove('entering'); view.offsetWidth; view.classList.add('entering');
  wireConnections();
}

function connCard(id) {
  const c = CONN[id], p = PROVIDERS[id];
  return `<div class="conn" data-conn="${id}" data-state="${c.state}">
    <div class="conn-head">${logo(id).replace('class="logo "', 'class="logo"')}<div class="t"><b>${APP[id]}</b><small>${c.state === 'connected' ? c.account : id === 'antigravity' ? 'Google' : id === 'codex' ? 'OpenAI' : 'Anthropic'}</small></div>
      <span class="conn-state" role="status"><i></i><span data-label>${STATE_LABEL[c.state]}</span></span></div>
    <div class="conn-body">${connBody(id)}</div>
    <div class="conn-foot">${connFoot(id)}</div>
  </div>`;
}
function connBody(id) {
  const c = CONN[id];
  switch (c.state) {
    case 'connected': return `
      <dl class="facts"><dt>Version</dt><dd>${c.version}${c.update ? ` · <span style="color:var(--color-running)">${c.update} available</span>` : ''}</dd>
        <dt>Chats found</dt><dd>${c.chats} in <span class="mono">${c.home}</span></dd>
        <dt>Usage</dt><dd>${USAGE[id].fiveHour.left}% of 5-hour · ${USAGE[id].weekly.left}% of weekly left</dd></dl>
      <div class="conn-toggles">
        <div class="toggle-row"><span>Show its chats in Recent chats</span><button class="switch" type="button" role="switch" aria-checked="${c.showChats}" data-tg="showChats" aria-label="Show ${APP[id]} chats in Recent chats"></button></div>
        <div class="toggle-row"><span>Suggest it for new chats</span><button class="switch" type="button" role="switch" aria-checked="${c.suggest}" data-tg="suggest" aria-label="Suggest ${APP[id]} for new chats"></button></div>
      </div>
      ${c.note ? `<div class="conn-note">${icon('help')}${c.note}</div>` : ''}`;
    case 'missing': return `<span>${APP[id]} isn’t on this computer yet. Installing takes about a minute and uses the official ${id === 'claude' ? 'Anthropic' : id === 'codex' ? 'OpenAI' : 'Google'} installer.</span>`;
    case 'installing': return `<span class="step-text" data-step>${icon('refresh', 'sm')}Downloading ${APP[id]}…</span><div class="progress" role="progressbar" aria-label="Install progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i style="--p:0"></i></div>`;
    case 'signedout': return `<span class="step-text"><span class="done-mark">${icon('check')}</span>Installed. Sign in to finish setting up.</span><span>You’ll sign in on ${id === 'claude' ? 'claude.ai' : id === 'codex' ? 'chatgpt.com' : 'your Google account'} in your browser, then come back here.</span>`;
    case 'signin': return `<span class="step-text">${statusIcon('running')}Finish signing in in your browser</span><span>We opened ${id === 'claude' ? 'claude.ai' : id === 'codex' ? 'chatgpt.com' : 'Google sign-in'}. This page updates on its own when you’re done.</span>`;
    case 'error': return `<span class="step-text" style="color:var(--color-danger)">${icon('x', 'sm')}Sign-in didn’t finish</span><span>The browser window closed before ${APP[id]} got your sign-in. Try again, and keep the window open until it says you’re done.</span>`;
  }
}
function connFoot(id) {
  const c = CONN[id];
  switch (c.state) {
    case 'connected': return `${c.update ? `<button class="btn" type="button" data-do="update">${icon('refresh', 'sm')}Update to ${c.update}</button>` : `<button class="btn ghost" type="button" data-do="check">${icon('refresh', 'sm')}Check for updates</button>`}<span class="grow"></span><button class="btn ghost" type="button" data-do="signout">Sign out</button>`;
    case 'missing': return `<span class="grow"></span><button class="btn primary" type="button" data-do="install"><span class="label">Install ${APP[id]}</span></button>`;
    case 'installing': return `<span class="grow"></span><button class="btn ghost" type="button" data-do="cancel">Cancel</button>`;
    case 'signedout': return `<span class="grow"></span><button class="btn primary" type="button" data-do="signin">Sign in</button>`;
    case 'signin': return `<button class="link-btn" type="button" data-do="reopen">${icon('external', 'sm')}Open the browser again</button><span class="grow"></span><button class="btn ghost" type="button" data-do="cancel">Cancel</button>`;
    case 'error': return `<span class="grow"></span><button class="btn primary" type="button" data-do="signin">Try again</button>`;
  }
}
function laterCard(l) {
  const on = notifyMe.has(l.name);
  return `<div class="conn later"><div class="conn-head"><span class="logo-tile">${l.tile}</span><div class="t"><b>${l.name}</b><small><span class="badge ${l.badge[0]}">${l.badge[1]}</span></small></div></div>
    <div class="conn-body"><span>${l.text}</span></div>
    <div class="conn-foot"><span class="grow"></span><button class="btn ${on ? '' : 'ghost'}" type="button" data-notify="${l.name}" aria-pressed="${on}"><span class="label">${on ? `${icon('check', 'sm')}We’ll let you know` : `${icon('bell', 'sm')}Notify me`}</span></button></div></div>`;
}

/* Re-render one card in place, keeping the page still */
function updateConn(id, state) {
  CONN[id].state = state;
  const card = document.querySelector(`[data-conn="${id}"]`); if (!card) return;
  card.dataset.state = state;
  swapText(card.querySelector('[data-label]'), STATE_LABEL[state]);
  card.querySelector('.conn-head small').textContent = state === 'connected' ? CONN[id].account : { claude: 'Anthropic', codex: 'OpenAI', antigravity: 'Google' }[id];
  card.querySelector('.conn-body').innerHTML = connBody(id);
  card.querySelector('.conn-foot').innerHTML = connFoot(id);
  wireCard_(card, id);
  renderSidebar();
  const head = document.querySelector('#connPage .page-head .source');
  if (head) head.innerHTML = `<span class="live-dot"></span>${PIDS.filter(x => CONN[x].state === 'connected').length} of ${PIDS.length} connected`;
  document.getElementById('navConn').textContent = PIDS.filter(x => CONN[x].state === 'connected').length;
}

let installTimer;
function runInstall(id) {
  updateConn(id, 'installing');
  const steps = [[0.35, `Downloading ${APP[id]} ${CONN[id].version}…`], [0.7, 'Checking the download'], [0.92, 'Installing'], [1, 'Installed']];
  let i = 0;
  const card = () => document.querySelector(`[data-conn="${id}"]`);
  const next = () => {
    if (CONN[id].state !== 'installing') return;
    const [p, text] = steps[i];
    const bar = card()?.querySelector('.progress'); if (!bar) return;
    bar.querySelector('i').style.setProperty('--p', p); bar.setAttribute('aria-valuenow', Math.round(p * 100));
    if (i > 0) swapStep(card().querySelector('[data-step]'), text);
    i++;
    installTimer = setTimeout(i < steps.length ? next : () => updateConn(id, 'signedout'), i < steps.length ? 700 : 500);
  };
  setTimeout(next, 120);
}
function swapStep(el, text) {
  if (!el) return;
  if (KB.reduced()) { el.innerHTML = `${icon('refresh', 'sm')}${text}`; return; }
  el.classList.add('out');
  setTimeout(() => { el.innerHTML = `${icon(text === 'Installed' ? 'check' : 'refresh', 'sm')}${text}`; el.classList.remove('out'); el.classList.add('in'); el.offsetWidth; el.classList.remove('in'); }, KB.ms('--duration-swap'));
}
let signinTimer;
function runSignin(id) {
  updateConn(id, 'signin');
  toast(`Opened ${id === 'claude' ? 'claude.ai' : id === 'codex' ? 'chatgpt.com' : 'Google sign-in'} in your browser`);
  clearTimeout(signinTimer);
  signinTimer = setTimeout(() => {
    if (CONN[id].state !== 'signin') return;
    if (connFailNext) { connFailNext = false; updateConn(id, 'error'); return; }
    updateConn(id, 'connected');
    if (!PROVIDERS[id].connectedOnce) toast(`${APP[id]} is connected. Its chats now show in Recent chats`);
  }, 2600);
}

function wireCard_(card, id) {
  card.querySelectorAll('[data-tg]').forEach(s => s.addEventListener('click', () => {
    const k = s.dataset.tg; CONN[id][k] = !CONN[id][k]; s.setAttribute('aria-checked', CONN[id][k]);
    if (k === 'showChats') renderSidebar();
  }));
  card.querySelectorAll('[data-do]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const a = b.dataset.do;
    if (a === 'install') runInstall(id);
    if (a === 'signin') runSignin(id);
    if (a === 'reopen') toast('Opened the sign-in page again');
    if (a === 'cancel') { clearTimeout(installTimer); clearTimeout(signinTimer); updateConn(id, a === 'cancel' && CONN[id].state === 'installing' ? 'missing' : 'signedout'); }
    if (a === 'check') { const lbl = b; lbl.innerHTML = `${statusIcon('running')}Checking…`; setTimeout(() => { lbl.innerHTML = `${icon('check', 'sm')}Up to date`; }, 900); }
    if (a === 'update') { b.disabled = true; b.innerHTML = `${statusIcon('running')}Updating…`; setTimeout(() => { CONN[id].version = CONN[id].update; delete CONN[id].update; updateConn(id, 'connected'); toast(`${APP[id]} updated to ${CONN[id].version}`); }, 1400); }
    if (a === 'signout') confirmSignout(id, b);
  }));
}
function confirmSignout(id, anchor) {
  let pop = document.getElementById('confirmPop');
  if (!pop) { pop = document.createElement('div'); pop.id = 'confirmPop'; pop.className = 'popover confirm'; pop.dataset.state = 'closed'; pop.setAttribute('role', 'alertdialog'); pop.addEventListener('click', e => e.stopPropagation()); document.body.append(pop); }
  pop.innerHTML = `<b>Sign out of ${APP[id]}?</b><p>Agent Kanban stops starting ${APP[id]} chats and reading its usage. Your chats stay in ${APP[id]}, and running chats keep going there.</p>
    <div class="row"><button class="btn ghost" type="button" data-c="no">Cancel</button><button class="btn danger" type="button" data-c="yes">Sign out</button></div>`;
  pop.querySelector('[data-c="no"]').onclick = () => closePops();
  pop.querySelector('[data-c="yes"]').onclick = () => { closePops(); updateConn(id, 'signedout'); toast(`Signed out of ${APP[id]}`); };
  openPop(pop, anchor, { align: 'right' });
  pop.querySelector('[data-c="no"]').focus({ preventScroll: true });
}

function wireConnections() {
  document.querySelectorAll('[data-conn]').forEach(card => wireCard_(card, card.dataset.conn));
  document.querySelectorAll('[data-notify]').forEach(b => b.addEventListener('click', () => {
    const n = b.dataset.notify, on = !notifyMe.has(n); on ? notifyMe.add(n) : notifyMe.delete(n);
    b.setAttribute('aria-pressed', on); b.classList.toggle('ghost', !on);
    const label = b.querySelector('.label'); label.classList.add('swapping');
    setTimeout(() => { label.innerHTML = on ? `${icon('check', 'sm')}We’ll let you know` : `${icon('bell', 'sm')}Notify me`; label.classList.remove('swapping'); }, KB.ms('--duration-swap') / 2);
  }));
  document.getElementById('reqBtn').addEventListener('click', () => {
    const i = document.getElementById('reqInput'); if (!i.value.trim()) { i.focus(); return; }
    toast(`Thanks. We’ve noted ${i.value.trim()}`); i.value = '';
  });
  document.getElementById('demoSetup').addEventListener('click', () => { CONN.codex.version = '0.156.1'; updateConn('codex', 'missing'); document.querySelector('[data-conn="codex"]').scrollIntoView({ block: 'nearest', behavior: KB.reduced() ? 'auto' : 'smooth' }); });
  document.getElementById('demoFail').addEventListener('click', () => { connFailNext = true; updateConn('antigravity', 'signedout'); });
}

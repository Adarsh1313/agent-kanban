/* First-run onboarding (Welcome → Connect → Chats → Notifications → Ready) and the empty board.
   Uses the globals from board.html and connections.js. */

const ORIGINAL_COLUMNS = new Map(chats.map(c => [c.id, c.column]));
const MARK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/></svg>';

/* ═════════ Empty board ═════════ */
function updateEmptyBoard() {
  const total = chats.filter(onBoard).length, anyFilter = Object.values(filters).some(Boolean);
  const empty = total === 0 && !anyFilter;
  board.classList.toggle('is-empty', empty);
  let box = document.getElementById('boardEmpty');
  if (!empty) { box?.remove(); return; }
  if (box) return;
  const connected = PIDS.filter(id => CONN[id].state === 'connected');
  const history = chats.filter(c => !c.archived && !c.column && connected.includes(c.provider) && CONN[c.provider].showChats).slice(0, 3);
  box = document.createElement('div'); box.id = 'boardEmpty'; box.className = 'board-empty'; box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'Empty board');
  box.innerHTML = connected.length ? `
    <div class="empty-art" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <h2>Nothing on the board yet</h2>
    <p>Start a chat and it shows up in Running, then moves across the board on its own as the agent works.</p>
    <div class="acts"><button class="btn primary" type="button" id="emptyStart">${icon('plus', 'sm')}Start a chat <span class="kbd">N</span></button>
      <button class="btn ghost" type="button" id="emptyProjects">${icon('projects', 'sm')}Browse projects</button></div>
    ${history.length ? `<div class="recent"><div class="k">OR PICK UP WHERE YOU LEFT OFF</div>
      ${history.map(c => `<button class="rc" type="button" data-rc="${c.id}">${logo(c.provider, 'sm')}<span class="t">${c.title}</span><small>${c.project} · ${c.ago}</small></button>`).join('')}</div>` : ''}`
    : `
    <div class="empty-art" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <h2>Connect an agent to get started</h2>
    <p>Agent Kanban runs the coding agents already on this computer. Connect Claude Code, Codex or Antigravity and your board fills up as they work.</p>
    <div class="acts"><button class="btn primary" type="button" id="emptyConnect">${icon('plug', 'sm')}Connect an agent</button></div>`;
  board.append(box);
  box.querySelector('#emptyStart')?.addEventListener('click', e => { e.stopPropagation(); openDialog(); });
  box.querySelector('#emptyProjects')?.addEventListener('click', () => go('projects'));
  box.querySelector('#emptyConnect')?.addEventListener('click', () => go('connections'));
  box.querySelectorAll('[data-rc]').forEach(b => b.addEventListener('click', () => openPanel(+b.dataset.rc)));
}
// Keep it in step with every board change
const _refreshCounts = refreshCounts;
refreshCounts = function (animate) { _refreshCounts(animate); updateEmptyBoard(); };

function showEmptyBoard() {
  document.getElementById('boardEmpty')?.remove();
  chats.forEach(c => { if (c.column) c.column = null; c.reason = null; });
  notifs.length = 0; renderNotifs();
  Object.keys(filters).forEach(k => filters[k] = null);
  if (currentView !== 'board') go('board');
  renderBoard(); renderSidebar(); renderFilterBar(); renderUsage(); closePanel();
}
function restoreSample() {
  chats.forEach(c => { c.column = ORIGINAL_COLUMNS.get(c.id) ?? null; c.archived = false; c.snoozed = false; });
  chats.find(c => c.id === 3).reason = 'permission'; chats.find(c => c.id === 4).reason = 'question';
  PIDS.forEach(id => CONN[id].state = 'connected');
  renderBoard(); renderSidebar(); renderUsage();
  if (currentView !== 'board') go('board');
}

/* ═════════ Onboarding ═════════ */
const onb = { step: 0, agents: {}, show: {}, desktop: true, sound: true };
const STEP_COUNT = 4; // Welcome isn't counted

function startOnboarding() {
  closePops(); closePanel();
  // A brand-new computer: Claude signed in, Codex installed but signed out, Antigravity missing
  onb.step = 0;
  onb.agents = { claude: 'detecting', codex: 'detecting', antigravity: 'detecting' };
  onb.final = { claude: 'connected', codex: 'signedout', antigravity: 'missing' };
  onb.show = { claude: true, codex: true, antigravity: true };
  let el = document.getElementById('onb');
  if (!el) {
    el = document.createElement('div'); el.id = 'onb'; el.className = 'onb'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Set up Agent Kanban');
    el.innerHTML = `<div class="onb-top"><div class="brand"><span class="mark">${MARK}</span>Agent Kanban</div>
      <div class="onb-steps" id="onbSteps"><small id="onbCount"></small><div class="onb-bar">${'<i></i>'.repeat(STEP_COUNT)}</div></div></div>
      <div class="onb-stage" id="onbStage"></div>`;
    document.body.append(el);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) document.querySelector('#onbStage [data-primary]:not(:disabled)')?.click(); });
  }
  el.dataset.state = 'open';
  renderStep();
}
function finishOnboarding(then) {
  // Carry what the user did into the app
  PIDS.forEach(id => { CONN[id].state = onb.agents[id] === 'connected' ? 'connected' : onb.agents[id] === 'missing' ? 'missing' : 'signedout'; CONN[id].showChats = onb.show[id]; });
  prefs.desktop = onb.desktop; prefs.sound = onb.sound;
  document.getElementById('swNotif').setAttribute('aria-checked', prefs.desktop); document.getElementById('swSound').setAttribute('aria-checked', prefs.sound);
  showEmptyBoard();
  document.getElementById('navConn').textContent = PIDS.filter(id => CONN[id].state === 'connected').length;
  document.getElementById('onb').dataset.state = 'closed';
  setTimeout(() => then && then(), 160);
}

function setProgress() {
  const steps = document.getElementById('onbSteps');
  steps.setAttribute('aria-hidden', onb.step === 0);
  document.getElementById('onbCount').textContent = onb.step ? `Step ${onb.step} of ${STEP_COUNT}` : '';
  steps.querySelectorAll('.onb-bar i').forEach((i, n) => i.style.setProperty('--f', n < onb.step ? 1 : 0));
}

function renderStep(back) {
  setProgress();
  const stage = document.getElementById('onbStage');
  stage.innerHTML = `<div class="onb-pane ${back ? 'back' : ''}">${[welcomeStep, connectStep, chatsStep, notifyStep, readyStep][onb.step]()}</div>`;
  [null, wireConnect, wireChats, wireNotify, wireReady][onb.step]?.();
  stage.querySelector('[data-next]')?.addEventListener('click', () => { onb.step++; renderStep(); });
  stage.querySelector('[data-back]')?.addEventListener('click', () => { onb.step--; renderStep(true); });
  stage.querySelector('[data-primary]')?.focus({ preventScroll: true });
  if (onb.step === 0) playMini();
}

/* Step 0 — Welcome, with a tiny board that shows the idea */
function welcomeStep() {
  const col = (id, name, body) => `<div class="mc" data-mc="${id}"><div class="mh">${statusIcon(id)}${name}</div>${body}</div>`;
  return `<h1>All your coding agents<br>on one board</h1>
    <p class="lead">Start chats with Claude Code, Codex and Antigravity, watch them work, and always know how much of each plan you have left.</p>
    <div class="mini" id="mini" aria-hidden="true">
      ${col('running', 'Running', `<div class="mcard" id="miniCard"><b>Add a sign-up page</b><div class="row">${logo('claude', 'sm')}Sonnet</div><div class="sweep"></div></div>`)}
      ${col('needs', 'Needs you', `<div class="mcard"><b>Fix newsletter links</b><div class="row">${logo('codex', 'sm')}<span class="badge needs">Permission</span></div></div>`)}
      ${col('review', 'Review', `<div class="mcard"><b>Sales summary</b><div class="row">${logo('antigravity', 'sm')}Gemini 3 Pro</div></div>`)}
      ${col('done', 'Done', '')}
    </div>
    <div class="onb-foot"><span class="grow">Takes about a minute. Nothing in your agent apps changes.</span><button class="btn primary" type="button" data-next data-primary>Get started</button></div>`;
}
let miniTimer;
function playMini() {
  clearTimeout(miniTimer);
  const order = ['running', 'needs', 'running', 'review', 'done'];
  let i = 0;
  const stepMini = () => {
    const card = document.getElementById('miniCard'); if (!card || onb.step !== 0) return;
    i = (i + 1) % order.length;
    const target = document.querySelector(`[data-mc="${order[i]}"]`);
    flip([card], () => {
      target.insertBefore(card, target.querySelector('.mh').nextSibling);
      card.querySelector('.sweep').hidden = order[i] !== 'running';
      const row = card.querySelector('.row');
      row.innerHTML = order[i] === 'needs' ? `${logo('claude', 'sm')}<span class="badge needs">Question</span>` : `${logo('claude', 'sm')}${order[i] === 'done' ? 'Done' : 'Sonnet'}`;
    }, { lift: card });
    miniTimer = setTimeout(stepMini, i === order.length - 1 ? 2400 : 1500);
  };
  if (!KB.reduced()) miniTimer = setTimeout(stepMini, 1200);
}

/* Step 1 — Connect */
function agentRow(id) {
  const s = onb.agents[id];
  const sub = { detecting: `<span class="skel"></span>`, connected: `${icon('check', 'sm')}Found and signed in`, signedout: 'Installed, not signed in', missing: 'Not on this computer',
    installing: 'Installing…', signin: `${statusIcon('running')}Finish signing in in your browser` }[s];
  const act = { detecting: '', connected: `<span class="ok"><span class="done-mark">${icon('check')}</span>Connected</span>`,
    signedout: `<button class="btn" type="button" data-act="signin">Sign in</button>`, missing: `<button class="btn" type="button" data-act="install">Install</button>`,
    installing: `<div class="progress"><i style="--p:0"></i></div>`, signin: `<button class="btn ghost" type="button" data-act="cancel">Cancel</button>` }[s];
  return `<div class="agent" data-agent="${id}">${logo(id)}<div class="t"><b>${APP[id]}</b><small>${sub}</small></div>${act}</div>`;
}
function connectStep() {
  const n = PIDS.filter(id => onb.agents[id] === 'connected').length;
  return `<h1>Connect the agents you use</h1>
    <p class="lead">We looked on this computer. Your sign-in stays inside each app; Agent Kanban never sees passwords or tokens.</p>
    <div class="agent-list" id="agentList">${PIDS.map(agentRow).join('')}</div>
    <div class="onb-foot"><button class="btn ghost" type="button" data-back>Back</button><span class="grow" id="connHint">${n ? `${n} connected. You can add more later in Connections.` : 'Connect at least one to continue.'}</span>
      <button class="btn primary" type="button" data-next data-primary ${n ? '' : 'disabled'}>Continue</button></div>`;
}
function refreshAgent(id) {
  const row = document.querySelector(`[data-agent="${id}"]`); if (!row) return;
  row.outerHTML = agentRow(id);
  wireAgent(id);
  const n = PIDS.filter(x => onb.agents[x] === 'connected').length;
  const btn = document.querySelector('#onbStage [data-next]'); if (btn) btn.disabled = !n;
  const hint = document.getElementById('connHint'); if (hint) hint.textContent = n ? `${n} connected. You can add more later in Connections.` : 'Connect at least one to continue.';
}
function wireAgent(id) {
  const row = document.querySelector(`[data-agent="${id}"]`);
  row.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'install') {
      onb.agents[id] = 'installing'; refreshAgent(id);
      const bar = () => document.querySelector(`[data-agent="${id}"] .progress i`);
      [0.4, 0.75, 1].forEach((p, n) => setTimeout(() => bar()?.style.setProperty('--p', p), 150 + n * 600));
      setTimeout(() => { onb.agents[id] = 'signedout'; refreshAgent(id); }, 2100);
    }
    if (a === 'signin') {
      onb.agents[id] = 'signin'; refreshAgent(id); toast(`Opened ${id === 'claude' ? 'claude.ai' : id === 'codex' ? 'chatgpt.com' : 'Google sign-in'} in your browser`);
      onb.timers = onb.timers || {}; onb.timers[id] = setTimeout(() => { if (onb.agents[id] === 'signin') { onb.agents[id] = 'connected'; refreshAgent(id); } }, 2200);
    }
    if (a === 'cancel') { clearTimeout(onb.timers?.[id]); onb.agents[id] = 'signedout'; refreshAgent(id); }
  }));
}
function wireConnect() {
  PIDS.forEach(wireAgent);
  // Detection resolves one by one
  PIDS.forEach((id, n) => { if (onb.agents[id] === 'detecting') setTimeout(() => { onb.agents[id] = onb.final[id]; refreshAgent(id); }, 500 + n * 350); });
}

/* Step 2 — Chats found in each connected agent's history */
function chatsStep() {
  const ids = PIDS.filter(id => onb.agents[id] === 'connected');
  const projects = PROJECTS.filter(p => p.owners.some(o => ids.includes(o)));
  return `<h1>Bring in your chats</h1>
    <p class="lead">These are the chats already in your agent apps. They show up in the sidebar, grouped by project, with the same titles.</p>
    <div class="found">${ids.map(id => `<div class="f"><span class="h">${logo(id, 'sm')}${APP[id]}</span><span class="n" data-count="${CONN[id].chats}">0</span><span class="h">chats</span>
      <div class="toggle-row" style="margin-top:6px"><span>Show in sidebar</span><button class="switch" type="button" role="switch" aria-checked="${onb.show[id]}" data-show="${id}" aria-label="Show ${APP[id]} chats in the sidebar"></button></div></div>`).join('')}</div>
    <div><div class="k" style="font-size:var(--text-micro);color:var(--color-text-faint);font-weight:500;margin-bottom:6px">FOUND IN ${projects.length} PROJECTS</div>
      <div class="proj-chips">${projects.map((p, i) => `<span style="animation-delay:${400 + i * 40}ms">${p.owners.filter(o => ids.includes(o)).map(o => logo(o, 'sm')).join('')}${p.id}</span>`).join('')}</div></div>
    <div class="reassure">${icon('eye')}<span>We only read chat titles and project folders. Nothing changes in your agent apps, and opening a chat here continues the same chat there.</span></div>
    <div class="onb-foot"><button class="btn ghost" type="button" data-back>Back</button><span class="grow"></span><button class="btn primary" type="button" data-next data-primary>Continue</button></div>`;
}
function wireChats() {
  document.querySelectorAll('[data-show]').forEach(s => s.addEventListener('click', () => { const id = s.dataset.show; onb.show[id] = !onb.show[id]; s.setAttribute('aria-checked', onb.show[id]); }));
  // Count up quickly; the number settles with an ease-out
  document.querySelectorAll('[data-count]').forEach(el => {
    const to = +el.dataset.count;
    if (KB.reduced()) { el.textContent = to; return; }
    const t0 = performance.now(), dur = 700;
    const tick = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(to * e); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(() => { el.textContent = to; }, dur + 100); // in case the window is hidden
  });
}

/* Step 3 — Notifications */
function notifyStep() {
  return `<h1>Know when an agent needs you</h1>
    <p class="lead">Agents stop to ask permission or a question. We’ll tell you, so you don’t have to keep checking the board.</p>
    <div class="sample-note">${logo('codex')}<div><b>Wispr flow local setup</b><small>Codex wants to run a command</small></div></div>
    <div class="settings-list">
      <div class="toggle-row"><span>Desktop notifications<small>Shows even when Agent Kanban is in the background</small></span><button class="switch" type="button" role="switch" aria-checked="${onb.desktop}" id="onbDesk" aria-label="Desktop notifications"></button></div>
      <div class="toggle-row"><span>Sound<small>A soft chime. <button class="link-btn" type="button" id="onbPlay" style="height:auto;padding:0 2px;display:inline">Play it</button></small></span><button class="switch" type="button" role="switch" aria-checked="${onb.sound}" id="onbSound" aria-label="Sound"></button></div>
    </div>
    <div class="onb-foot"><button class="btn ghost" type="button" data-back>Back</button><span class="grow">Windows will ask to allow notifications.</span><button class="btn primary" type="button" data-next data-primary>Continue</button></div>`;
}
function wireNotify() {
  document.getElementById('onbDesk').addEventListener('click', e => { onb.desktop = !onb.desktop; e.currentTarget.setAttribute('aria-checked', onb.desktop); });
  document.getElementById('onbSound').addEventListener('click', e => { onb.sound = !onb.sound; e.currentTarget.setAttribute('aria-checked', onb.sound); if (onb.sound) chime(true); });
  document.getElementById('onbPlay').addEventListener('click', () => chime(false));
}

/* Step 4 — Ready */
function readyStep() {
  const ids = PIDS.filter(id => onb.agents[id] === 'connected');
  const chatsN = ids.reduce((n, id) => n + (onb.show[id] ? CONN[id].chats : 0), 0);
  const projN = PROJECTS.filter(p => p.owners.some(o => ids.includes(o))).length;
  const lines = [
    `${ids.length} agent${ids.length === 1 ? '' : 's'} connected: ${ids.map(id => APP[id]).join(', ')}`,
    `${chatsN} chats from ${projN} projects in the sidebar`,
    onb.desktop || onb.sound ? `Notifications on${onb.sound ? ', with sound' : ''}` : 'Notifications off. Turn them on from the bell any time',
  ];
  return `<div class="ready-mark">${icon('check')}</div>
    <h1>You’re set up</h1>
    <div class="summary">${lines.map((l, i) => `<div style="animation-delay:${200 + i * 60}ms">${icon('check', 'sm')}${l}</div>`).join('')}</div>
    <p class="lead">Start your first chat: pick a project, and we’ll suggest the agent with the most room left.</p>
    <div class="onb-foot"><button class="btn ghost" type="button" id="onbBoard">Go to the board</button><span class="grow"></span><button class="btn primary" type="button" data-primary id="onbStart">${icon('plus', 'sm')}Start your first chat</button></div>`;
}
function wireReady() {
  document.getElementById('onbStart').addEventListener('click', () => finishOnboarding(() => openDialog()));
  document.getElementById('onbBoard').addEventListener('click', () => finishOnboarding());
}

/* ═════════ Settings menu: prototype controls ═════════ */
document.getElementById('settingsBtn').addEventListener('click', e => {
  e.stopPropagation();
  actionPop.innerHTML = `<div class="pane"><div class="menu-label">Prototype</div>
    <button class="menu-item" type="button" data-s="onb">${icon('play')}Replay onboarding</button>
    <button class="menu-item" type="button" data-s="empty">${icon('board')}Show the empty board</button>
    <button class="menu-item" type="button" data-s="sample">${icon('resume')}Restore sample data</button></div>`;
  actionPop.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => {
    closePops(); ({ onb: startOnboarding, empty: showEmptyBoard, sample: restoreSample })[b.dataset.s]();
  }));
  openPop(actionPop, e.currentTarget);
  // Open upward from the sidebar foot
  const r = e.currentTarget.getBoundingClientRect(); actionPop.style.top = Math.max(8, r.top - actionPop.offsetHeight - 6) + 'px'; actionPop.style.setProperty('--origin', 'left bottom');
});

const params = new URLSearchParams(location.search);
if (params.has('onboarding')) startOnboarding();
else if (params.has('empty')) showEmptyBoard();

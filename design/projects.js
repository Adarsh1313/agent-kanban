/* Projects view: every folder an agent has worked in, and what each provider knows about it.
   Uses the globals from board.html (PROJECTS, chats, PROVIDERS, PIDS, APP, logo, icon, glyph…). */

// What the app reads from each folder (read-only): stack, git, instruction files, top folders.
const PROJECT_INFO = {
  'open-project': { stack: ['HTML', 'CSS', 'Node 25'], branch: 'main', commit: 'design: sidebar with recent chats', commitAgo: '10m', files: { claude: true, codex: false, antigravity: false }, tree: ['design/', 'docs/specs/', '.claude/'] },
  'lila-black': { stack: ['TypeScript', 'Vite', 'Parquet'], branch: 'feat/heatmap', commit: 'Add replay timeline scrubber', commitAgo: '2h', files: { claude: false, codex: true, antigravity: true }, tree: ['src/', 'data/', 'public/', 'scripts/'] },
  'local-flow': { stack: ['Python 3.12', 'faster-whisper'], branch: 'main', commit: 'Scratchpad copy confirmation', commitAgo: '1d', files: { claude: true, codex: true, antigravity: false }, tree: ['localflow/', 'design/', 'tests/'] },
  'Portfolio': { stack: ['Next.js', 'TypeScript', 'Tailwind'], branch: 'main', commit: 'Live demo link on case studies', commitAgo: '1h', files: { claude: true, codex: false, antigravity: false }, tree: ['app/', 'components/', 'content/', 'public/'] },
  '20x': { stack: ['Node', 'Express'], branch: 'main', commit: 'Repo overview notes', commitAgo: '5d', files: { claude: false, codex: false, antigravity: false }, tree: ['src/', 'docs/'] },
  'github-manage': { stack: ['Shell', 'GitHub CLI'], branch: 'main', commit: 'Archive old forks script', commitAgo: '6d', files: { claude: true, codex: false, antigravity: false }, tree: ['scripts/'] },
};
const INSTRUCTION_FILE = { claude: 'CLAUDE.md', codex: 'AGENTS.md', antigravity: 'GEMINI.md' };

const agoMins = a => a === 'now' ? 0 : /^\d+m$/.test(a) ? parseInt(a) : /^\d+h$/.test(a) ? parseInt(a) * 60 : a === 'Yesterday' ? 1440 : /^\d+d$/.test(a) ? parseInt(a) * 1440 : /^\d+w$/.test(a) ? parseInt(a) * 10080 : 99999;
const agoLabel = a => a === 'now' ? 'just now' : a === 'Yesterday' ? 'yesterday' : `${a} ago`;
const projChats = id => chats.filter(c => c.project === id && !c.archived);
const lastActive = id => projChats(id).map(c => c.ago).sort((a, b) => agoMins(a) - agoMins(b))[0] || '—';

const projectsState = { mode: 'list', id: null, sort: 'activity', q: '', chatFilter: 'all', firstPaint: true };

function renderProjects(arg, { back } = {}) {
  if (arg) { projectsState.mode = 'detail'; projectsState.id = arg; projectsState.chatFilter = 'all'; }
  const page = document.getElementById('projectsPage');
  page.innerHTML = projectsState.mode === 'detail' ? projectDetailHtml(projectsState.id) : projectListHtml();
  const view = document.getElementById('viewProjects');
  view.classList.remove('entering', 'from-left'); view.offsetWidth; view.classList.add('entering'); if (back) view.classList.add('from-left');
  page.scrollTop = 0;
  projectsState.mode === 'detail' ? wireProjectDetail() : wireProjectList();
  bindTooltips(page);
  document.getElementById('crumb').textContent = projectsState.mode === 'detail' ? ` › ${projectsState.id}` : '';
}

/* ───────── List ───────── */
function projectListHtml() {
  const q = projectsState.q.toLowerCase();
  let list = PROJECTS.filter(p => !q || p.id.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  list = list.sort(projectsState.sort === 'name' ? (a, b) => a.id.localeCompare(b.id) : (a, b) => agoMins(lastActive(a.id)) - agoMins(lastActive(b.id)));
  const stagger = projectsState.firstPaint; projectsState.firstPaint = false;
  const rows = list.map((p, i) => {
    const cs = projChats(p.id);
    const n = k => cs.filter(c => c.column === k && !c.snoozed).length;
    const hist = cs.filter(c => !c.column).length, total = cs.length || 1;
    const seg = [['running', 'var(--color-running)'], ['needs', 'var(--color-needs)'], ['review', 'var(--color-review)'], ['done', 'var(--color-done)']]
      .map(([k, col]) => n(k) ? `<i style="width:${n(k) / total * 100}%;background:${col}"></i>` : '').join('') + (hist ? `<i style="width:${hist / total * 100}%;background:var(--color-border-strong)"></i>` : '');
    const legend = [['running', 'working'], ['needs', 'need you'], ['review', 'to review']].filter(([k]) => n(k)).map(([k, l]) => `<span>${statusIcon(k)}${n(k)} ${l}</span>`).join('') || `<span>${cs.length} chat${cs.length === 1 ? '' : 's'}, all quiet</span>`;
    return `<div class="prow ${stagger ? 'stagger' : ''}" style="${stagger ? `animation-delay:${i * 40}ms` : ''}" role="link" tabindex="0" data-open="${p.id}">
      <div class="name">${glyph(p, 28).replace('class="folder-glyph"', 'class="folder-glyph big-glyph"')}<span><b>${p.id}</b><small>${p.path}</small></span></div>
      <div class="who-knows">${p.owners.map(o => `<span class="p" data-tip="${PROVIDERS[o].name} has ${cs.filter(c => c.provider === o).length} chats here">${logo(o, 'sm')}${cs.filter(c => c.provider === o).length}</span>`).join('')}</div>
      <div class="statusbar"><span class="bar">${seg}</span><span class="legend">${legend}</span></div>
      <div class="when">${agoLabel(lastActive(p.id))}</div>
      <div class="go">${icon('chevron-right')}</div>
    </div>`;
  }).join('');
  return `<div class="page-inner">
    <div class="page-head"><div class="t"><h1>Projects <span class="count" style="font-size:var(--text-body);color:var(--color-text-faint);font-weight:400">${PROJECTS.length}</span></h1>
      <p>Every folder an agent has worked in, found in your Claude Code, Codex and Antigravity history. Open one to see which providers know it and what they can read.</p></div>
      <label class="search">${icon('search', 'sm')}<input id="projSearch" placeholder="Search projects" value="${projectsState.q}" aria-label="Search projects"></label>
      <button class="btn" type="button" id="addFolder">${icon('folder', 'sm')}Add a folder</button>
    </div>
    ${list.length ? `<div class="plist" role="table" aria-label="Projects">
      <div class="plist-head" role="row"><button type="button" data-sort="name" ${projectsState.sort === 'name' ? 'aria-sort="ascending"' : ''}>Project${projectsState.sort === 'name' ? icon('chevron-down', 'sm') : ''}</button><span>Worked on with</span><span>Chats</span>
        <button type="button" data-sort="activity" ${projectsState.sort === 'activity' ? 'aria-sort="descending"' : ''}>Last activity${projectsState.sort === 'activity' ? icon('chevron-down', 'sm') : ''}</button><span></span></div>
      ${rows}</div>`
    : `<div class="page-empty">${icon('search')}<h3>No projects match “${projectsState.q}”</h3><p>Check the spelling, or add the folder yourself.</p><button class="btn" type="button" id="clearSearch">Clear search</button></div>`}
  </div>`;
}
function wireProjectList() {
  const s = document.getElementById('projSearch');
  s.addEventListener('input', () => {
    projectsState.q = s.value; const pos = s.selectionStart;
    renderProjects(); const s2 = document.getElementById('projSearch'); s2.focus(); s2.setSelectionRange(pos, pos);
    document.getElementById('viewProjects').classList.remove('entering');
  });
  document.getElementById('clearSearch')?.addEventListener('click', () => { projectsState.q = ''; renderProjects(); });
  document.getElementById('addFolder').addEventListener('click', () => toast('Opens the folder picker. A new folder works with any provider'));
  document.querySelectorAll('.plist-head [data-sort]').forEach(b => b.addEventListener('click', () => { projectsState.sort = b.dataset.sort; renderProjects(); document.getElementById('viewProjects').classList.remove('entering'); }));
  document.querySelectorAll('.prow').forEach(r => {
    const open = () => renderProjects(r.dataset.open);
    r.addEventListener('click', open);
    r.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  });
}

/* ───────── Detail ───────── */
function projectDetailHtml(id) {
  const p = proj(id), info = PROJECT_INFO[id], cs = projChats(id);
  const order = { needs: 0, running: 1, review: 2, done: 3 };
  const filtered = cs.filter(c => projectsState.chatFilter === 'all' || c.provider === projectsState.chatFilter)
    .sort((a, b) => (order[a.column] ?? 4) - (order[b.column] ?? 4) || agoMins(a.ago) - agoMins(b.ago));
  const know = PIDS.map(pid => {
    const mine = cs.filter(c => c.provider === pid);
    if (!p.owners.includes(pid)) return `<div class="know off"><div class="h">${logo(pid)}${PROVIDERS[pid].name}</div><p>Hasn't worked in this project yet.</p></div>`;
    const last = mine.map(c => c).sort((a, b) => agoMins(a.ago) - agoMins(b.ago))[0];
    return `<div class="know"><div class="h">${logo(pid)}${PROVIDERS[pid].name}<span class="r">${mine.length} chat${mine.length === 1 ? '' : 's'}</span></div>
      <p>Last used ${last ? agoLabel(last.ago) : '—'}${last ? ` · ${last.model}` : ''}</p>
      <button class="btn" type="button" data-newwith="${pid}">${icon('plus', 'sm')}New ${PROVIDERS[pid].name} chat</button></div>`;
  }).join('');
  const segBtns = [['all', 'All', ''], ...p.owners.map(o => [o, PROVIDERS[o].name, logo(o, 'sm')])];
  return `<div class="page-inner">
    <div class="crumbs"><button type="button" id="toList">${icon('back', 'sm')}Projects</button><span>/</span><span>${p.id}</span></div>
    <div class="page-head"><div class="t"><h1>${glyph(p, 28).replace('class="folder-glyph"', 'class="folder-glyph big-glyph"')}${p.id}</h1><p class="mono" style="font-size:12px">${p.path}</p></div>
      <button class="btn" type="button" id="openFolder">${icon('folder', 'sm')}Open folder</button>
      <button class="btn primary" type="button" id="newInProject">${icon('plus', 'sm')}New chat</button></div>
    <div class="detail">
      <div>
        <h2 class="section-title">Providers that know this project</h2>
        <div class="know-grid">${know}</div>
        <h2 class="section-title">Chats <span class="r"><span class="seg" id="chatSeg"><span class="thumb"></span>${segBtns.map(([v, l, h]) => `<button type="button" data-v="${v}" aria-pressed="${projectsState.chatFilter === v}">${h}${l}</button>`).join('')}</span></span></h2>
        <div class="chat-list">${filtered.map(c => `<div class="crow" role="button" tabindex="0" data-chat="${c.id}">
            ${c.column && !c.snoozed ? statusIcon(c.column) : `<span class="nostate" title="In ${APP[c.provider]} history"></span>`}${logo(c.provider, 'sm')}<span class="t">${c.title}</span>
            ${c.column === 'needs' ? reasonBadge(c) : ''}${c.snoozed ? `<span class="badge quiet">${icon('snooze', 'sm')}Snoozed</span>` : ''}
            <span class="m">${c.model}<span>·</span>${agoLabel(c.ago)}</span></div>`).join('') || `<div class="page-empty" style="padding:var(--space-6)">No chats from this provider yet.</div>`}</div>
      </div>
      <aside class="about" aria-label="About this project">
        <div class="blk"><span class="k">LOCATION</span><span class="path">${p.path}</span><button class="link-btn" type="button" id="copyPath" style="align-self:flex-start;margin-left:-8px">${icon('copy', 'sm')}Copy path</button></div>
        <div class="blk"><span class="k">BUILT WITH</span><span class="v">${info.stack.map(s => `<span class="tagchip">${s}</span>`).join('')}</span></div>
        <div class="blk"><span class="k">GIT</span><span class="v">${icon('branch', 'sm')}<span class="mono">${info.branch}</span></span><span class="v" style="color:var(--color-text-muted)">${info.commit} · ${info.commitAgo} ago</span></div>
        <div class="blk"><span class="k">INSTRUCTIONS EACH PROVIDER READS</span>
          ${PIDS.map(pid => `<div class="file-line">${info.files[pid] ? `<span class="ok">${icon('check', 'sm')}</span>` : `<span class="no">${icon('x', 'sm')}</span>`}<span class="mono">${INSTRUCTION_FILE[pid]}</span><small>${logo(pid, 'sm')}${info.files[pid] ? 'Found' : 'Not in this folder'}</small></div>`).join('')}
        </div>
        <div class="blk"><span class="k">TOP FOLDERS</span><div class="tree">${info.tree.map((f, i) => `<div><span>${i === info.tree.length - 1 ? '└─' : '├─'}</span> ${f}</div>`).join('')}</div></div>
      </aside>
    </div>
  </div>`;
}
function wireProjectDetail() {
  const id = projectsState.id;
  document.getElementById('toList').addEventListener('click', () => { projectsState.mode = 'list'; renderProjects(null, { back: true }); });
  document.getElementById('openFolder').addEventListener('click', () => toast(`Opens ${proj(id).path} in your file explorer`));
  document.getElementById('copyPath').addEventListener('click', e => {
    const b = e.currentTarget; b.innerHTML = `${icon('check', 'sm')}Copied`; setTimeout(() => { b.innerHTML = `${icon('copy', 'sm')}Copy path`; }, 1400);
  });
  document.getElementById('newInProject').addEventListener('click', e => { e.stopPropagation(); openDialog(id); });
  document.querySelectorAll('[data-newwith]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation(); openDialog(id); draft.provider = b.dataset.newwith; draft.model = MODELS[draft.provider][0]; renderDialog();
  }));
  document.querySelectorAll('.crow').forEach(r => {
    r.addEventListener('click', () => openPanel(+r.dataset.chat));
    r.addEventListener('keydown', e => { if (e.key === 'Enter') openPanel(+r.dataset.chat); });
  });
  bindSeg(document.getElementById('chatSeg'), v => {
    projectsState.chatFilter = v;
    const list = document.querySelector('.chat-list'), y = document.getElementById('projectsPage').scrollTop;
    document.getElementById('projectsPage').innerHTML = projectDetailHtml(id); wireProjectDetail(); bindTooltips(document.getElementById('projectsPage'));
    document.getElementById('projectsPage').scrollTop = y;
    document.querySelectorAll('.crow').forEach((r, i) => { if (!KB.reduced()) r.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 180, delay: i * 30, easing: KB.css('--ease-out'), fill: 'backwards' }); });
  });
}

/* Segmented control with a sliding thumb */
function bindSeg(seg, onChange) {
  const thumb = seg.querySelector('.thumb'), btns = [...seg.querySelectorAll('button')];
  const place = (b, instant) => { if (instant) thumb.style.transition = 'none'; thumb.style.width = b.offsetWidth + 'px'; thumb.style.transform = `translateX(${b.offsetLeft - 2}px)`; if (instant) { thumb.offsetWidth; thumb.style.transition = ''; } };
  const cur = btns.find(b => b.getAttribute('aria-pressed') === 'true') || btns[0];
  requestAnimationFrame(() => place(cur, true));
  btns.forEach(b => b.addEventListener('click', () => {
    if (b.getAttribute('aria-pressed') === 'true') return;
    btns.forEach(x => x.setAttribute('aria-pressed', x === b)); place(b);
    setTimeout(() => onChange(b.dataset.v), KB.ms('--duration-move') * 0.6);
  }));
}

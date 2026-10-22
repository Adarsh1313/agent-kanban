/* Agent Kanban interaction helpers shared by design-system.html and board.html.
   Plain JS, no dependencies. Motion values are read from tokens.css. */
(() => {
  const root = document.documentElement;
  const css = name => getComputedStyle(root).getPropertyValue(name).trim();
  const ms = name => parseFloat(css(name)) || 0;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Icons (one stroke family, 24px grid) ──
  const ICONS = {
    board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
    inbox: '<path d="M4 13h4l1.5 3h5L16 13h4"/><path d="M5 5h14l1 8v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5z"/>',
    gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>',
    plug: '<path d="M9 3v5M15 3v5"/><path d="M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    'chevron-right': '<path d="M9 6l6 6-6 6"/>',
    updown: '<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
    play: '<path d="M8 5.5l10 6.5-10 6.5z"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    terminal: '<path d="M4 6l6 6-6 6M12 18h8"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4"/>',
    send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/>',
    search2: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    resume: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  };
  function icon(name, cls = '') {
    return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  // ── Column state icons (Linear-style, 14px) ──
  function statusIcon(state) {
    switch (state) {
      case 'running': return `<svg class="status running" viewBox="0 0 14 14" aria-hidden="true"><circle class="track" cx="7" cy="7" r="5.5" fill="none" stroke-width="1.6"/><circle class="arc" cx="7" cy="7" r="5.5" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="9 26"/></svg>`;
      case 'needs': return `<svg class="status" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="var(--color-needs)"/><path d="M7 3.8v3.6" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><circle cx="7" cy="9.9" r=".95" fill="#fff"/></svg>`;
      case 'review': return `<svg class="status" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-review)" stroke-width="1.6"/><path d="M7 3.5A3.5 3.5 0 1 1 3.5 7H7z" fill="var(--color-review)"/></svg>`;
      case 'done': return `<svg class="status" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="var(--color-done)"/><path d="M4.4 7.2l1.8 1.8 3.4-3.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    return '';
  }

  // ── Provider logos (files in assets/providers, from the LobeHub icon set) ──
  const PROVIDERS = {
    claude: { name: 'Claude', file: 'claude-color.svg', plan: 'Max' },
    codex: { name: 'Codex', file: 'codex-color.svg', plan: 'Plus' },
    antigravity: { name: 'Antigravity', file: 'antigravity-color.svg', plan: 'Pro' },
  };
  function logo(id, size = '') {
    const p = PROVIDERS[id];
    return `<img class="logo ${size}" src="assets/providers/${p.file}" alt="${p.name}" width="16" height="16">`;
  }

  // ── FLIP: measure, change the DOM, animate from the old spot ──
  function flip(elements, mutate, { lift } = {}) {
    const els = [...elements];
    const first = new Map(els.map(el => [el, el.getBoundingClientRect()]));
    mutate();
    if (reduced()) return Promise.resolve();
    const dur = ms('--duration-move'), easing = css('--ease-in-out');
    return Promise.all(els.map(el => {
      const a = first.get(el), b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (!dx && !dy) return Promise.resolve();
      const isLift = lift && lift === el;
      if (isLift) el.classList.add('lifted');
      const anim = el.animate([
        { transform: `translate(${dx}px, ${dy}px)${isLift ? ` scale(${css('--lift-scale')})` : ''}` },
        { transform: 'translate(0, 0) scale(1)' },
      ], { duration: dur, easing });
      return anim.finished.catch(() => {}).then(() => el.classList.remove('lifted'));
    }));
  }

  // ── Crossfade a line of text through a short blur ──
  function swapText(el, html) {
    if (reduced()) { el.innerHTML = html; return; }
    el.classList.add('out');
    setTimeout(() => {
      el.innerHTML = html;
      el.classList.remove('out'); el.classList.add('in');
      el.offsetWidth; // commit the "in" start state
      el.classList.remove('in');
    }, ms('--duration-swap'));
  }

  // ── Disclosure (Show more / sidebar sections / model breakdown) ──
  function bindDisclosure(btn, region, { labels } = {}) {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open);
      region.classList.toggle('closed', !open);
      if (labels) btn.querySelector('.lbl').textContent = open ? labels[1] : labels[0];
    });
  }

  // ── Popovers: open from the trigger, close on outside click or Escape ──
  const openPops = new Set();
  function bindPopover(trigger, pop, { place } = {}) {
    const setOpen = open => {
      pop.dataset.state = open ? 'open' : 'closed';
      trigger.setAttribute('aria-expanded', open);
      if (open) { place && place(trigger, pop); openPops.add(close); } else openPops.delete(close);
    };
    const close = () => setOpen(false);
    trigger.addEventListener('click', e => { e.stopPropagation(); const willOpen = pop.dataset.state !== 'open'; closeAll(); setOpen(willOpen); });
    pop.addEventListener('click', e => e.stopPropagation());
    return { open: () => setOpen(true), close };
  }
  function closeAll() { [...openPops].forEach(fn => fn()); }
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });

  // ── Toast with an action (Undo) ──
  function toast(message, action) {
    let host = document.querySelector('.toasts');
    if (!host) { host = document.createElement('div'); host.className = 'toasts'; host.setAttribute('role', 'status'); document.body.append(host); }
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span>${message}</span>`;
    let timer;
    const leave = () => { clearTimeout(timer); t.classList.add('leaving'); setTimeout(() => t.remove(), ms('--duration-exit')); };
    if (action) {
      const b = document.createElement('button'); b.className = 'btn'; b.textContent = action.label;
      b.onclick = () => { action.run(); leave(); };
      t.append(b);
    }
    host.append(t);
    let left = ms('--duration-toast'), started = Date.now();
    const arm = () => { started = Date.now(); timer = setTimeout(leave, left); };
    const pause = () => { clearTimeout(timer); left -= Date.now() - started; };
    t.addEventListener('mouseenter', pause); t.addEventListener('mouseleave', arm);
    document.addEventListener('visibilitychange', () => document.hidden ? pause() : arm());
    arm();
  }

  // ── Tooltips: delay the first, show neighbours instantly ──
  let tipEl, tipTimer, warmUntil = 0;
  function bindTooltips(scope = document) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.dataset.state = 'closed'; tipEl.setAttribute('role', 'tooltip'); document.body.append(tipEl); }
    scope.querySelectorAll('[data-tip]').forEach(el => {
      if (el.dataset.tipBound) return; el.dataset.tipBound = '1';
      el.addEventListener('mouseenter', () => {
        const warm = Date.now() < warmUntil;
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => {
          tipEl.textContent = el.dataset.tip;
          const r = el.getBoundingClientRect();
          tipEl.classList.toggle('instant', warm);
          tipEl.style.left = Math.max(8, r.left + r.width / 2 - tipEl.offsetWidth / 2) + 'px';
          tipEl.style.top = (r.bottom + 6) + 'px';
          tipEl.style.setProperty('--origin', 'top center');
          tipEl.dataset.state = 'open';
        }, warm ? 0 : 450);
      });
      el.addEventListener('mouseleave', () => { clearTimeout(tipTimer); if (tipEl.dataset.state === 'open') warmUntil = Date.now() + 400; tipEl.dataset.state = 'closed'; });
    });
  }

  // ── Sidebar capsule that slides to the selected item ──
  function bindNav(list, onSelect) {
    const cap = list.querySelector('.cap'), items = [...list.querySelectorAll('.navitem')];
    const place = it => { cap.style.transform = `translateY(${it.offsetTop}px)`; };
    items.forEach(it => it.addEventListener('click', () => {
      items.forEach(x => x.removeAttribute('aria-current')); it.setAttribute('aria-current', 'page'); place(it); onSelect && onSelect(it);
    }));
    const cur = items.find(i => i.hasAttribute('aria-current')) || items[0];
    cap.style.transition = 'none'; place(cur); cap.offsetWidth; cap.style.transition = '';
  }

  // ── Usage level from percent left ──
  const level = left => left < 5 ? 'out' : left < 25 ? 'low' : 'ok';

  function toggleTheme() {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
  }

  window.KB = { css, ms, reduced, icon, statusIcon, logo, PROVIDERS, flip, swapText, bindDisclosure, bindPopover, closeAll, toast, bindTooltips, bindNav, level, toggleTheme };
})();

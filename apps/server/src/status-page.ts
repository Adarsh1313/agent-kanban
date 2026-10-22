// A small live console served at GET /?token=… so the running server can be seen in a browser.
// It is a debug view of the real API (not the web app): it reads the same routes and listens on the WebSocket.

export function statusPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Kanban Server</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --card:#fff; --line:#e7e7e4; --text:#1a1a19; --muted:#6e6e6a; --ok:#2f8a57; --warn:#c98a12; --bad:#c8402f; --run:#3b6fd8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#121213; --card:#1a1a1c; --line:#2a2a2d; --text:#ececea; --muted:#9a9a96; --ok:#5fc28a; --warn:#e0a43a; --bad:#ff7a6b; --run:#6f95f0; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:13px/1.5 "Segoe UI", system-ui, sans-serif; }
  main { max-width:1180px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:20px; margin:0; display:flex; align-items:center; gap:10px; }
  h2 { font-size:13px; text-transform:none; color:var(--muted); font-weight:600; margin:24px 0 8px; }
  .live { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); font-weight:400; }
  .live i { width:8px; height:8px; border-radius:50%; background:var(--bad); }
  .live.on i { background:var(--ok); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px; }
  .row { display:flex; align-items:center; gap:8px; justify-content:space-between; }
  .muted { color:var(--muted); font-size:12px; }
  .pill { font-size:11px; padding:1px 7px; border-radius:99px; border:1px solid var(--line); }
  .s-connected,.s-ok { color:var(--ok); } .s-update_available,.s-unavailable,.s-signed_out { color:var(--warn); } .s-degraded,.s-not_installed,.s-error { color:var(--bad); }
  .bar { height:5px; border-radius:99px; background:var(--line); overflow:hidden; margin:3px 0 6px; }
  .bar i { display:block; height:100%; background:var(--text); }
  .board { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
  .col h3 { font-size:12px; margin:0 0 6px; }
  .chat { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px; margin-bottom:6px; }
  .chat b { display:block; font-weight:500; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:8px; }
  td { padding:6px 10px; border-top:1px solid var(--line); vertical-align:top; }
  tr:first-child td { border-top:0; }
  #events { font-family:Consolas, monospace; font-size:12px; max-height:220px; overflow:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
  button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--text); border-radius:6px; padding:3px 10px; cursor:pointer; }
  @media (max-width:760px) { .board { grid-template-columns:1fr 1fr; } }
</style>
</head>
<body>
<main>
  <div class="row"><h1>Agent Kanban server <span class="live" id="live"><i></i><span>connecting…</span></span></h1>
    <span><button id="check">Check connections</button> <button id="refresh">Refresh usage</button></span></div>
  <p class="muted">Live view of the running server. Data comes from the real API and updates over the WebSocket.</p>

  <h2>Connections</h2><div class="grid" id="connections"></div>
  <h2>Usage left</h2><div class="grid" id="usage"></div>
  <h2>Board</h2><div class="board" id="board"></div>
  <h2>Live events</h2><div id="events"><span class="muted">Waiting for events…</span></div>
  <h2>Chat history found on this computer <span class="muted" id="histCount"></span></h2><table id="history"></table>
</main>
<script>
  const token = new URLSearchParams(location.search).get('token') || '';
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const NAMES = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const ago = iso => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : m < 1440 ? Math.round(m/60) + 'h ago' : Math.round(m/1440) + 'd ago'; };
  const api = (p, o = {}) => fetch(p, { ...o, headers: H }).then(r => r.ok ? r.json() : Promise.reject(r.status));

  async function connections() {
    const list = await api('/api/connections');
    document.getElementById('connections').innerHTML = list.map(h => '<div class="card"><div class="row"><b>' + NAMES[h.provider] + '</b><span class="pill s-' + h.status + '">' + h.status.replace('_',' ') + '</span></div>'
      + '<div class="muted">Version ' + esc(h.version || '—') + ' · latest ' + esc(h.latestVersion || '—') + ' · signed in ' + (h.signedIn === null ? '?' : h.signedIn ? 'yes' : 'no') + '</div>'
      + (h.message ? '<div class="muted">' + esc(h.message) + '</div>' : '') + '<div class="muted">Checked ' + ago(h.checkedAt) + '</div></div>').join('');
  }
  async function usage() {
    const u = await api('/api/usage');
    document.getElementById('usage').innerHTML = u.readings.map(r => '<div class="card"><div class="row"><b>' + NAMES[r.provider] + (u.suggested === r.provider ? ' <span class="pill s-ok">most room</span>' : '') + '</b><span class="pill s-' + r.status + '">' + r.status + '</span></div>'
      + (r.windows.length ? r.windows.map(w => '<div class="row muted"><span>' + esc(w.label) + '</span><span>' + w.leftPct + '% left' + (w.resetsAt ? ' · resets ' + new Date(w.resetsAt).toLocaleString() : '') + '</span></div><div class="bar"><i style="width:' + w.leftPct + '%"></i></div>').join('') : '<div class="muted">' + esc(r.message || 'No numbers yet') + '</div>')
      + '</div>').join('');
  }
  async function board() {
    const chats = await api('/api/chats');
    const cols = [['running','Running'],['needs_you','Needs you'],['review','Review'],['done','Done']];
    document.getElementById('board').innerHTML = cols.map(([k, n]) => {
      const cs = chats.filter(c => c.column === k);
      return '<div class="col"><h3>' + n + ' <span class="muted">' + cs.length + '</span></h3>' + (cs.map(c => '<div class="chat"><b>' + esc(c.title) + '</b><span class="muted">' + NAMES[c.provider] + (c.needsReason ? ' · ' + c.needsReason : '') + ' · ' + ago(c.updatedAt) + '</span></div>').join('') || '<div class="muted">Empty</div>') + '</div>';
    }).join('');
  }
  async function history() {
    const h = await api('/api/history');
    document.getElementById('histCount').textContent = h.length + ' chats';
    document.getElementById('history').innerHTML = h.slice(0, 25).map(c => '<tr><td>' + NAMES[c.provider] + '</td><td>' + esc(c.title) + '</td><td class="muted">' + esc(c.cwd) + '</td><td class="muted">' + ago(c.updatedAt) + '</td></tr>').join('');
  }
  const log = (t) => { const el = document.getElementById('events'); if (el.querySelector('.muted')) el.innerHTML = ''; el.insertAdjacentHTML('afterbegin', '<div>' + new Date().toLocaleTimeString() + '  ' + esc(t) + '</div>'); };
  function socket() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + encodeURIComponent(token));
    const live = document.getElementById('live');
    ws.onopen = () => { live.classList.add('on'); live.lastChild.textContent = 'live'; };
    ws.onclose = () => { live.classList.remove('on'); live.lastChild.textContent = 'reconnecting…'; setTimeout(socket, 2000); };
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      log(e.type + (e.chat ? ' · ' + e.chat.title + ' → ' + e.chat.column : '') + (e.health ? ' · ' + e.health.provider + ' ' + e.health.status : '') + (e.reading ? ' · ' + e.reading.provider + ' ' + e.reading.status : '') + (e.kind ? ' · ' + e.kind : ''));
      if (e.type === 'connection.updated') connections();
      if (e.type === 'usage.updated') usage();
      if (e.type === 'chat.updated') board();
    };
  }
  document.getElementById('check').onclick = () => api('/api/connections/check', { method: 'POST', body: '{}' }).then(connections);
  document.getElementById('refresh').onclick = () => api('/api/usage/refresh', { method: 'POST', body: '{}' }).then(usage);
  Promise.allSettled([connections(), usage(), board(), history()]);
  socket();
</script>
</body>
</html>`;
}

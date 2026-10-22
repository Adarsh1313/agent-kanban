# Agent Kanban Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock prototype with the real app: the designed board, chat panel, New chat, usage, filters, notifications, sidebar and Projects page, running on the Plan 1 server's live API and WebSocket, so the user can start, continue, approve, stop and finish real Claude Code and Codex chats from the browser.

**Architecture:** A Vite + React app in `apps/web`, served by the Plan 1 server from `apps/web/dist` at `http://127.0.0.1:3006/`. One client store applies `ServerEvent`s through a pure reducer; components read it with `useSyncExternalStore`. Styling imports the existing `design/tokens.css`, `design/components.css`, `design/views.css` directly (single source of truth); behaviour follows `design/board.html`, `design/projects.js`, `design/connections.js`. A few server routes are added for things the UI needs and the API lacks.

**Tech Stack:** react@19.3.1, react-dom@19.3.1, vite@8.3.5, @vitejs/plugin-react@6.1.2, typescript@7.0.2, vitest@5.0.5, @testing-library/react@16.3.3, @testing-library/user-event@14.6.8, jsdom@30.1.3, @types/react@19.3.0, @types/react-dom@19.3.0. Server side: unchanged stack from Plan 1.

**Spec:** `docs/specs/2026-10-22-agent-kanban-design.md` (sections 5, 6, 11). Design: `design/design-brief.md`, `design/design-system.html`, `design/board.html`. Server API: `apps/server/src/api.ts`, `packages/shared/src/types.ts`.

## Global Constraints

- The web app talks only to the local server (`/api/*`, `/ws`). No other network calls except Google Fonts for Geist / Geist Mono (as the design does).
- Token: read once from `?token=` on load, kept in `sessionStorage` under `agent-kanban.token`, removed from the address bar with `history.replaceState`, sent as `Authorization: Bearer` on every request and as `?token=` on the WebSocket only. Never logged, never put in other URLs.
- Styles come from `design/*.css` imported as-is; new CSS goes into `apps/web/src/styles/app.css` and uses only tokens from `design/tokens.css` (no raw hex or px outside tokens, except 1px borders).
- Copy follows `design/design-brief.md` (plain words; "Needs you", "Stopped", "Resets 2:40 pm"; display names "Claude Code", "Codex", "Antigravity"). User-visible errors show the server's `error` text.
- Motion follows the design-system motion table (`design/design-system.html` §Motion) and token durations/easings; every animation has a `prefers-reduced-motion` fallback; card moves use FLIP.
- Keyboard: N opens New chat, F opens Filter, Esc closes the top-most popover/dialog/panel. Visible focus on every interactive element.
- Server routes added here require the token like all others. Static assets under `/assets/*` and the SPA shell are served without the token; the shell contains no data.
- Dev: `npm run dev -w apps/web` runs Vite on 3005 with `/api` and `/ws` proxied to `http://127.0.0.1:3006`.

## Review Focus

1. **The server restarts while the page is open.** The socket drops and the old token stops working: the app shows "Reconnecting…", retries with backoff (1, 2, 4 … 30 s); on a 401 it shows "The server restarted. Open Agent Kanban again from the link it printed." instead of a blank page — pinned in Task 2.
2. **Events arrive before the data they refer to** (`message.delta` for a chat the store hasn't loaded, events during the initial load): the reducer buffers or fetches the chat; nothing is dropped or duplicated — pinned in Task 3.
3. **Very large data:** 1 000+ history chats and a chat with 2 000 messages render without freezing (sidebar caps per design; thread renders the latest 200 with "Show earlier") — pinned in Tasks 4 and 6.
4. **A user action fails** (409 "active in Claude Code", 400 "That folder doesn't exist.", 404): the server's message shows in a toast and the card/panel state is unchanged — pinned in Tasks 5–7.
5. **Two tabs open:** both stay consistent from WebSocket events; a request answered in one tab disappears in the other — pinned in Task 3.

---

## File structure

```
apps/server/src/static.ts          serve apps/web/dist + SPA fallback
apps/server/src/projects.ts        group chats + history by folder; read-only folder info
apps/server/src/api.ts             (modify) new routes, /console moves the Plan 1 status page
apps/web/package.json, vite.config.ts, tsconfig.json, index.html
apps/web/src/main.tsx              bootstrap (token, store, socket, <App/>)
apps/web/src/api/client.ts         fetch wrapper + typed endpoints
apps/web/src/api/socket.ts         WebSocket with reconnect + resync
apps/web/src/state/store.ts        createStore, useStore(selector)
apps/web/src/state/reducer.ts      applyEvent / applySnapshot (pure)
apps/web/src/state/selectors.ts    filters, groupings, suggestion, counts
apps/web/src/ui/primitives/        Popover, Menu, Tooltip, Toasts, Dialog, Switch, icons.tsx, Logo.tsx, flip.ts
apps/web/src/ui/shell/             Sidebar, TopBar, App (routing)
apps/web/src/ui/board/             Board, Column, Card, ActivityLine, EmptyBoard
apps/web/src/ui/chat/              ChatPanel, Thread, RequestCard, Composer, ChatActionsMenu
apps/web/src/ui/newchat/           NewChatDialog
apps/web/src/ui/usage/             UsageChips, UsagePopover, UsageFocus
apps/web/src/ui/filters/           FilterMenu, FilterBar
apps/web/src/ui/notify/            Bell, NotificationsPopover, notifier.ts
apps/web/src/ui/projects/          ProjectsPage, ProjectDetail
apps/web/src/ui/connections/       ConnectionsPage (read-only health in this plan)
apps/web/src/styles/app.css
apps/web/test/**                   vitest + Testing Library
```

---

### Task 1: Server additions for the web app

**Files:** Create `apps/server/src/static.ts`, `apps/server/src/projects.ts`; Modify `apps/server/src/api.ts`, `apps/server/src/store.ts`, `apps/server/src/chats.ts`, adapters (`listModels`); Test `apps/server/test/static.test.ts`, `projects.test.ts`, `api.test.ts`.

**Interfaces:**
- Produces (shared types): `interface Project { id: string /* absolute cwd */; name: string /* basename */; path: string; providers: { provider: ProviderId; chats: number; lastUsedAt: string; lastModel: string | null }[]; columns: Record<Column, number>; historyOnly: number; lastActivityAt: string }`; `interface ProjectInfo { stack: string[]; git: { branch: string; lastCommit: string; lastCommitAt: string } | null; instructionFiles: Record<ProviderId, boolean>; topFolders: string[] }`; `interface ModelOption { id: string; label: string; isDefault: boolean }`.
- Produces (routes): `GET /` (browser, valid `?token=`) → the SPA `index.html` when `apps/web/dist` exists, else the Plan 1 console; `GET /console?token=` → the Plan 1 status page; `GET /assets/*` → static files (no token; `Cache-Control: public, max-age=31536000, immutable`); unknown non-`/api` GET with `Accept: text/html` → `index.html`. `PATCH /api/chats/:id` body `{ title?: string; pinned?: boolean; snoozedUntil?: string | null }` → `Chat` (+ `chat.updated` broadcast). `GET /api/projects` → `Project[]` (newest activity first). `GET /api/projects/info?path=` → `ProjectInfo` (404 unless `path` is one of the projects). `GET /api/models` → `Record<ProviderId, ModelOption[]>` (Codex from `model/list`; Claude from the SDK `supportedModels()` on the shared usage query; a provider without an adapter → `[]`).
- `ProviderAdapter` gains `listModels(): Promise<ModelOption[]>`.

- [ ] **Step 1: Failing tests.** static: `/assets/x.js` served without token with the cache header; `GET /?token=<good>` with `Accept: text/html` returns the dist `index.html` when it exists and the console otherwise; path traversal (`/assets/../../package.json`, encoded variants) → 404. projects: two chats in `C:\a` (claude, codex) + one history chat in `C:\b` → two projects with the right provider counts, column counts, `historyOnly` 1, newest first; `info` for a fixture folder with `package.json` (react, vite deps) → stack `['React','Vite']`, `CLAUDE.md` present → `instructionFiles.claude true`, a non-git folder → `git: null`, top folders sorted, hidden folders and `node_modules` excluded; `info` for an unknown path → 404. api: PATCH pin/title/snooze round-trip + broadcast; PATCH empty title → 400; `/api/models` with fake adapters.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** Stack detection reads `package.json` dependencies (React, Next.js, Vite, Vue, Svelte, Express, TypeScript) and file markers (`pyproject.toml`/`requirements.txt` → Python, `go.mod` → Go, `Cargo.toml` → Rust). Git via `git -C <path> rev-parse --abbrev-ref HEAD` and `git -C <path> log -1 --format=%s%x00%cI` (10 s timeout, failures → null). All folder reads are read-only.
- [ ] **Step 4: Run tests, typecheck.**
- [ ] **Step 5: Commit** `feat(server): routes and static serving for the web app`.

---

### Task 2: Web app scaffold, API client and live socket

**Files:** Create `apps/web/{package.json,vite.config.ts,tsconfig.json,index.html}`, `apps/web/src/main.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/api/socket.ts`, `apps/web/src/styles/app.css`; Modify root `package.json` (scripts `dev:web`, `build:web`, test includes web), `.claude/launch.json` (design entry → web dev on 3005); Test `apps/web/test/client.test.ts`, `socket.test.ts`.

**Interfaces:**
- Produces: `readToken(): string | null` (from `?token=` then sessionStorage; strips the URL); `class ApiError extends Error { status: number }`; `api` object with one typed function per route (`listChats()`, `listMessages(id)`, `listRequests(id)`, `listToolCalls(id)`, `startChat(body)`, `send(id, text)`, `answer(id, requestId, decision)`, `stop(id)`, `done(id)`, `undone(id)`, `archive(id)`, `patchChat(id, patch)`, `history()`, `continueHistory(body)`, `usage()`, `refreshUsage()`, `connections()`, `checkConnections(provider?)`, `projects()`, `projectInfo(path)`, `models()`).
- Produces: `connectSocket(opts: { token: string; onEvent: (e: ServerEvent) => void; onStatus: (s: 'live' | 'reconnecting' | 'unauthorized') => void; onReconnected: () => void }): { close(): void }` — backoff 1, 2, 4, 8, 16, 30 s (cap), reset on open; a failed upgrade followed by `GET /api/chats` → 401 reports `unauthorized`.

- [ ] **Step 1: Scaffold** with the pinned versions; Vite `server.port 3005`, `strictPort`, proxy `/api` and `/ws` (ws: true) to `http://127.0.0.1:3006`; `server.fs.allow` includes `../../design`; `index.html` loads Geist + Geist Mono like `design/board.html`; `main.tsx` imports `../../../design/tokens.css`, `components.css`, `views.css`, then `./styles/app.css`. Vitest env jsdom.
- [ ] **Step 2: Failing tests:** `readToken` reads the query, stores it, strips it; falls back to sessionStorage; client sends the bearer header and throws `ApiError` with the server's `error` text and status; socket: backoff schedule with fake timers, `onReconnected` fires after a reconnect (not the first open), 401 → `unauthorized` and no further retries (Review Focus 1).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w apps/web` and `npm run build -w apps/web`; then start the server and open `http://127.0.0.1:3006/?token=…` in the browser — a placeholder `<App/>` renders and the address bar no longer shows the token.
- [ ] **Step 5: Commit** `feat(web): scaffold, api client and live socket`.

---

### Task 3: Store, event reducer and resync

**Files:** Create `apps/web/src/state/{store.ts,reducer.ts,selectors.ts}`; Test `apps/web/test/reducer.test.ts`, `selectors.test.ts`.

**Interfaces:**
- Produces: `interface AppState { chats: Record<string, Chat>; messages: Record<string, Message[]>; streaming: Record<string, Record<string, string>> /* chatId → messageId → text */; requests: Record<string, OpenRequest[]>; toolCalls: Record<string, ToolCall[]>; usage: Record<ProviderId, UsageReading>; suggested: ProviderId | null; connections: Record<ProviderId, ConnectionHealth>; history: HistoryChat[]; projects: Project[]; notifications: AppNotification[]; socket: 'live' | 'reconnecting' | 'unauthorized'; ui: UiState }` with `AppNotification { id: string; chatId: string; kind: ServerEvent['kind']; at: string; unread: boolean }` and `UiState { view: 'board' | 'projects' | 'connections'; projectId: string | null; openChatId: string | null; filters: Filters; focusProvider: ProviderId | null }`.
- Produces: `applyEvent(s: AppState, e: ServerEvent): AppState`; `applySnapshot(s, snap: { chats; usage; suggested; connections; history; projects })`; `createStore(initial)` with `getState`, `setState(fn)`, `subscribe`; `useStore<T>(selector: (s: AppState) => T): T`; `loadAll(api): Promise<Snapshot>`; `loadChat(id)` (messages, requests, tool calls).
- Produces (selectors): `boardColumns(s)`, `visibleChats(s)` (filters incl. provider focus), `recentChatsByProject(s)` (design: 4 projects × 3 chats), `pinned(s)`, `suggestFor(s, allowed)` (falls back to the first allowed provider with `suggested: false` when the server's suggestion is null — Plan 1 ruling), `unreadCount(s)`.

- [ ] **Step 1: Failing tests:** `chat.updated` inserts/updates; `message.delta` appends to `streaming` and `message.completed` replaces it with the final message (no duplicate); `message.delta` for an unknown chat is kept and the chat id is reported by `missingChats(s)` so the app fetches it (Review Focus 2); `request.opened` adds and a `chat.updated` that leaves needs_you clears that chat's requests (Review Focus 5); `notification` adds an unread item; `usage.updated` and `connection.updated` replace per provider; `applySnapshot` after a reconnect keeps streaming text for chats still running and drops stale requests; selectors: filters (provider, project, status, model, reason, activity, started-in) match `design/board.html` semantics; snoozed chats hidden until `snoozedUntil` passes.
- [ ] **Step 2: Run to verify they fail. Step 3: Implement. Step 4: Run tests.**
- [ ] **Step 5: Commit** `feat(web): store, event reducer, selectors`.

---

### Task 4: App shell — sidebar, top bar, routing, primitives

**Files:** Create `apps/web/src/ui/primitives/*`, `apps/web/src/ui/shell/{App,Sidebar,TopBar}.tsx`; copy `design/assets/providers/*.svg` to `apps/web/public/providers/`; Test `apps/web/test/shell.test.tsx`, `primitives.test.tsx`.

**Interfaces:**
- Produces primitives used by every later task: `<Popover anchor open onClose align>` (origin-aware, closes on outside click/Esc, one open at a time), `<Menu>` with sub-panes (pane-in animation), `<Tooltip label>` (450 ms first, instant within 400 ms), `toast(message, action?)` + `<Toasts/>` (5 s, pauses on hover/hidden), `<Dialog>`, `<Switch>`, `<Icon name>` (all icons from `design/components.js` ICONS), `<ProviderLogo id size>`, `<StatusIcon state>`, `flip(elements, mutate, { lift })` (port of `design/components.js` flip).
- Routing: hash routes `#/board`, `#/projects`, `#/projects/<encoded path>`, `#/connections`; the sidebar nav capsule slides (`--duration-move`).

- [ ] **Step 1: Failing tests:** popover outside-click and Esc close; only one popover open; tooltip timing with fake timers; toast pause on hover; sidebar: Providers rows toggle `focusProvider`; Pinned section hidden when empty; Recent chats shows the 4 most recent projects × 3 chats with "N more" and "All projects" (Review Focus 3 with 1 000 history items renders in < 200 ms in jsdom); routes switch views and the top-bar title/breadcrumb.
- [ ] **Step 2–4: Implement to the design (`design/board.html` sidebar markup/classes), run tests.**
- [ ] **Step 5: Commit** `feat(web): app shell, sidebar, primitives`.

---

### Task 5: Board

**Files:** Create `apps/web/src/ui/board/{Board,Column,Card,ActivityLine,EmptyBoard}.tsx`; Test `apps/web/test/board.test.tsx`.

**Interfaces:** Consumes `boardColumns`, `toolCalls` (latest running tool call is the activity line), `api.stop/done/undone/send`, `flip`, `toast`.

Behaviour (from `design/board.html`): four columns with status icon and count tick; cards show provider logo, model, project, relative time, needs-you badge (`permission` "Wants to run a command", `question` "Asked you a question", `stopped` "Stopped", `limit` "Limit reached · resets <time>", `error` "Something went wrong", `interrupted` "Interrupted"); running cards show the activity line (latest tool-call summary, crossfade on change) with Show more listing the last 5 tool calls; hover actions: Stop on running, Resume on stopped/interrupted (Resume = `send(id, "Continue where you left off.")`), "…" menu; Review/Done cards show tool-call count and duration; drag only to Done (from Done back to Review via `undone`), invalid drops snap back with the design's hint toast; cards move between columns with FLIP when `chat.updated` changes the column; empty board and no-results states from the design.

- [ ] **Step 1: Failing tests:** cards render per column from the store; a `chat.updated` moving a card calls `flip` with the card as `lift`; Stop calls `api.stop` and a 409/404 failure shows the server message in a toast without changing the card (Review Focus 4); Resume sends the continue text; drag to Done calls `api.done`, drag to Running is refused with the hint; empty board shows "Nothing on the board yet" with Start a chat and up to 3 recent history chats.
- [ ] **Step 2–4: Implement, run tests.** Then check in the browser against the real server: the board shows the real chats from earlier e2e runs.
- [ ] **Step 5: Commit** `feat(web): board`.

---

### Task 6: Chat panel

**Files:** Create `apps/web/src/ui/chat/{ChatPanel,Thread,RequestCard,Composer,ChatActionsMenu}.tsx`; Test `apps/web/test/chat.test.tsx`.

**Interfaces:** Consumes `loadChat`, `api.send/answer/stop/done/archive/patchChat/continueHistory`.

Behaviour (from `design/board.html` panel): slides in from the right (`--ease-drawer`); header with logo, title, state, model, project, Stop / Resume / Mark done, "…" and close; "Same chat as in Claude Code/Codex" source line; thread renders the latest 200 messages with "Show earlier" (Review Focus 3); streaming text from `streaming`; a "Worked · N steps" group per turn from tool calls (Show more); RequestCard for each open request: permission → Allow / Deny, question → reply box (sends `{ reply }`); composer: Enter sends, Shift+Enter newline; for a history-only chat the composer says "Continue this <app> chat" and sending calls `continueHistory` (409 shows the server's "active in Claude Code" message, Review Focus 4). Actions menu: Pin/Unpin (`patchChat`), Snooze (1 hour / this evening / tomorrow 9:00 / next Monday 9:00 → `snoozedUntil`), Rename (inline title edit → `patchChat`), Copy project path, Copy resume command (`claude --resume <sessionRef>` / `codex resume <sessionRef>`), Archive: the card collapses at once and an Undo toast shows for 5 s; `api.archive` is called only when the toast expires (archive is final on the server), and Undo restores the card without any server call.

- [ ] **Step 1: Failing tests:** opening a card loads messages/requests/tool calls once; deltas stream into the open thread; Allow calls `answer(id, requestId, 'allow')` and the request card disappears on the following `chat.updated`; question reply sends `{ reply }`; 2 000 messages → only 200 rendered until Show earlier; archive waits 5 s and Undo cancels the call; rename and pin call `patchChat`.
- [ ] **Step 2–4: Implement, run tests.** Browser check against the real server: open a real Claude chat from history, send "say hi", watch it stream and move to Review.
- [ ] **Step 5: Commit** `feat(web): chat panel`.

---

### Task 7: New chat dialog

**Files:** Create `apps/web/src/ui/newchat/NewChatDialog.tsx`; Test `apps/web/test/newchat.test.tsx`.

**Interfaces:** Consumes `projects`, `suggestFor`, `api.models`, `api.startChat`.

Behaviour (from `design/board.html` dialog): project first (projects found on this computer, with provider logos; "Choose another folder…" → a path input with validation via the server's 400 "That folder doesn't exist."); provider picker shows each provider's 5-hour and weekly left and disables providers that haven't worked in that project ("Hasn't worked on <project> yet"; a new folder allows any connected provider); "Suggested" from `suggestFor`; model picker from `/api/models` with "Default" first (omitted from the request); Ctrl+Enter starts; on success the dialog closes and the new card arrives in Running; empty prompt shakes the field.

- [ ] **Step 1: Failing tests:** allowed providers per project; suggestion fallback when the server suggestion is null; folder 400 shows inline; start sends `{ provider, cwd, prompt, model? }`; N opens the dialog, Esc closes it.
- [ ] **Step 2–4: Implement, run tests. Step 5: Commit** `feat(web): new chat dialog`.

---

### Task 8: Usage

**Files:** Create `apps/web/src/ui/usage/{UsageChips,UsagePopover,UsageFocus}.tsx`; Test `apps/web/test/usage.test.tsx`.

Behaviour (from the design): one chip per provider with two hairline meters (5-hour, weekly) and the lower percent; levels: under 25 % amber, under 5 % red; popover with 5-hour, weekly, resets, "By model" disclosure, "Most room" tag, Refresh (`api.refreshUsage`, spinner, "Checking…" → "Updated just now"); `error` readings show last numbers dimmed with the server's message; `unavailable` shows its message; focusing a provider (sidebar) shows `UsageFocus` with "Usage for all providers".

- [ ] **Step 1: Failing tests:** chips and levels from readings; error reading dimmed with message; refresh flow; focus mode.
- [ ] **Step 2–4: Implement, run tests. Step 5: Commit** `feat(web): usage`.

---

### Task 9: Filters

**Files:** Create `apps/web/src/ui/filters/{FilterMenu,FilterBar}.tsx`; Test `apps/web/test/filters.test.tsx`.

Behaviour (from the design): categories Provider, Project, Status, Model, Waiting on you for, Last activity, Started in; panes with Select all / None; search across values; chips "Provider is any of …" with ×; Clear all; F key; no-results state with Clear filters. Provider focus from the sidebar is the same filter.

- [ ] **Step 1–4: Tests (select none → no-results; chip removal; search jump), implement, run. Step 5: Commit** `feat(web): filters`.

---

### Task 10: Notifications

**Files:** Create `apps/web/src/ui/notify/{Bell,NotificationsPopover,notifier.ts}`; Test `apps/web/test/notify.test.tsx`.

Behaviour: bell with unread count, one damped ring per new notification (not under reduced motion), popover list ("<Provider> wants to run a command", "… asked you a question", "… finished. Ready for review", "… hit its usage limit", "… stopped with an error"), clicking opens the chat and marks read, Mark all read; switches Desktop notifications (browser `Notification`, permission requested on first enable, shown only when the tab is hidden) and Sound (the design's two-note chime via WebAudio); prefs in `localStorage` `agent-kanban.notify`.

- [ ] **Step 1–4: Tests with a mocked `Notification` and `AudioContext`, implement, run. Step 5: Commit** `feat(web): notifications`.

---

### Task 11: Projects page

**Files:** Create `apps/web/src/ui/projects/{ProjectsPage,ProjectDetail}.tsx`; Test `apps/web/test/projects.test.tsx`.

Behaviour (from `design/projects.js`): list with providers + chat counts, status bar, last activity, sort by name/activity, search; detail with "Providers that know this project" cards (dashed for providers that haven't worked there; "New <provider> chat" opens New chat preset), chats list with provider segmented filter, About column from `/api/projects/info` (location + copy, stack, git, instruction files per provider, top folders).

- [ ] **Step 1–4: Tests, implement, run. Step 5: Commit** `feat(web): projects page`.

---

### Task 12: Connections page (read-only) and end-to-end check

**Files:** Create `apps/web/src/ui/connections/ConnectionsPage.tsx`; Modify root scripts (`npm run build` builds web; `npm start` = server); Test `apps/web/test/connections.test.tsx`.

Behaviour: one card per provider from `connections` (status dot + word, version, latest, signed in, chats found = history count, usage summary, server message incl. the Codex model note), "Check now" (`api.checkConnections(provider)`), "Update available" note with the version. Install / Sign in / Sign out buttons are added in Plan 3; this plan shows a plain line "Setup from the app is coming next." for not-installed or signed-out providers.

- [ ] **Step 1–4: Tests, implement, run.**
- [ ] **Step 5: End-to-end in the browser against the real server** (`npm run build` then `AGENT_KANBAN_PORT=3006 npm start`, open the printed link): board shows real chats; start a Codex chat in a temp folder ("create hello.txt containing hi"), approve if asked, watch it move Running → Review; open a Claude history chat and continue it with "reply ok"; Stop a running chat and Resume it; usage chips match `/usage`; the bell rings on a permission request; restart the server and confirm the "server restarted" screen (Review Focus 1). Record results in the task report.
- [ ] **Step 6: Commit** `feat(web): connections page and build wiring`.

## Spec coverage

| Spec | Task |
|---|---|
| §5 columns and state shown live | 3, 5 |
| §6 Board, Chat, New chat, Usage, Connect (read-only) screens | 5, 6, 7, 8, 12 |
| §11 history chats, same-chat continue, projects decide providers, notifications, filters, chat actions | 4, 6, 7, 9, 10, 11 |
| Design system and motion | all UI tasks |

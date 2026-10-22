# Agent Kanban Connect and Antigravity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new user can open Agent Kanban, go through onboarding, install and sign in to Claude Code, Codex and Antigravity from the app (no terminal), and then run Antigravity chats on the board alongside Claude and Codex.

**Architecture:** Server: an Antigravity adapter speaking ACP (JSON-RPC 2.0 over stdio) to Google's official `agy_acp_server`, an Antigravity installer that downloads Google's pinned release and verifies its SHA-256, a `ConnectService` that runs the official installers and sign-in commands for each provider and streams progress as `connect.updated` events, and a small settings store. Web: the Connections page gets its actions, and an onboarding flow runs on first launch. Builds on Plan 1's adapter registry, health monitor and API, and Plan 2's UI primitives.

**Tech Stack:** Plan 1 + Plan 2 stacks; no new dependencies (zip extraction uses the system `tar`, available on Windows 10+, macOS and Linux).

**Spec:** `docs/specs/2026-10-22-agent-kanban-design.md` (§4 Antigravity row, §6 Connect, §7 ConnectService, §8 install/login errors). Design: `design/connections.js`, `design/onboarding.js`, `design/design-brief.md` (Revision 3, 4).

## Global Constraints

- Only official sources: Claude Code via `npm install -g @anthropic-ai/claude-code@latest`; Codex via `npm install -g @openai/codex@latest`; Antigravity via Google's `agy-acp-server` release from `https://dl.google.com/agy-extensions/releases/...` (version 1.3.0, URLs and SHA-256 per platform copied from T3 Code `apps/server/src/provider/antigravityRelease.ts`, MIT, with the attribution header).
- The official tools own sign-in: `claude auth login --claudeai`, `codex login`, and Antigravity's own ACP sign-in link. Agent Kanban opens the browser and watches status; it never reads, stores or forwards tokens, passwords or OAuth callbacks.
- Status checks: `claude auth status --json` (`loggedIn: boolean`), `codex login status` (exit 0 and text "Logged in"), Antigravity ACP `initialize` result (authenticated vs. sign-in required).
- Sign-in waits at most 5 minutes, then returns to signed out with "Sign-in didn't finish. Try again, and keep the browser window open until it says you're done."
- Every install/sign-in can be cancelled; cancel kills the child process tree (Plan 1 `taskkill /T /F` behaviour on Windows).
- Antigravity files live in `~/.agent-kanban/providers/antigravity/<version>/`; a partial download or extraction is deleted on failure.
- Copy follows `design/connections.js` and `design/onboarding.js` exactly where they define text.
- Antigravity terms: Google's terms forbid using an Antigravity login with third-party software other than official clients. This plan uses Google's own ACP server and its own sign-in; show the one-line note from the design ("Usage limits show only when Antigravity reports them itself.") and keep a note in the Connections card: "Uses Google's official Antigravity server." Re-check Google's terms before any public release.

## Review Focus

1. **Download interrupted or checksum mismatch:** Antigravity install ends in an error state with "The download didn't finish. Try again.", no partial files remain, and Retry works — pinned in Task 2.
2. **Sign-in abandoned:** the user closes the browser; after 5 minutes (or Cancel) the card returns to Signed out with the message above and no login process is left running — pinned in Task 4.
3. **npm missing or no permission** (`EACCES`/`EPERM` on a global install): a plain error "Couldn't install Codex: your computer didn't allow it. Try running Agent Kanban as an administrator, or install Codex yourself." and no half state — pinned in Task 4.
4. **Antigravity server crashes mid-turn:** the chat goes to Needs you / error with "Antigravity stopped unexpectedly. Resume to try again." and the next action restarts it (Plan 1 JsonRpcProcess behaviour) — pinned in Task 3.
5. **Provider already installed or signed in outside the app during onboarding:** detection picks it up within one check and the step shows Connected; no reinstall — pinned in Tasks 4 and 6.

---

## File structure

```
apps/server/src/adapters/acp.ts                 ACP client over JsonRpcProcess (jsonrpc 2.0 framing)
apps/server/src/adapters/antigravity.ts         AntigravityAdapter
apps/server/src/connect/antigravity-release.ts  pinned release table (T3, MIT)
apps/server/src/connect/antigravity-install.ts  download + verify + extract
apps/server/src/connect/service.ts              ConnectService (install / sign in / sign out / update / cancel)
apps/server/src/settings.ts                     settings in the store (onboarded, showChats per provider)
apps/server/src/api.ts                          (modify) connect + settings routes
apps/web/src/ui/connections/ConnectionsPage.tsx (modify) actions per state
apps/web/src/ui/onboarding/Onboarding.tsx       first-run flow
apps/server/test/fixtures/fake-acp-server.ts    fake Antigravity ACP server
```

---

### Task 1: ACP framing and client

**Files:** Modify `apps/server/src/adapters/jsonrpc.ts` (option `{ jsonrpc: '2.0' }` adds the field to every outgoing message); Create `apps/server/src/adapters/acp.ts`; Test `apps/server/test/acp.test.ts`, `apps/server/test/fixtures/fake-acp-server.ts`.

**Interfaces:**
- Produces: `class AcpClient` with `constructor(proc: JsonRpcProcess)`, `initialize(): Promise<{ protocolVersion: number; agentInfo?: { name: string; version: string }; authMethods: { id: string; name: string }[]; authenticated: boolean }>` (sends `{ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }`; `authenticated` is false when the agent requires authentication before `session/new`), `authenticate(methodId): Promise<void>`, `newSession(cwd): Promise<string>` (`session/new { cwd, mcpServers: [] }` → `sessionId`), `loadSession(sessionId, cwd): Promise<void>` (`session/load`), `prompt(sessionId, text): Promise<{ stopReason: string }>` (`session/prompt { sessionId, prompt: [{ type: 'text', text }] }`), `cancel(sessionId): void` (notification `session/cancel`), `onUpdate(fn: (sessionId, update) => void)` (notification `session/update`), `onPermission(fn: (sessionId, req) => Promise<{ optionId: string } | 'cancelled'>)` (request `session/request_permission` → result `{ outcome: { outcome: 'selected', optionId } }` or `{ outcome: { outcome: 'cancelled' } }`), `onAuthUrl(fn: (url) => void)` — fired when a stdout line starts with `Open the following link to authenticate the ACP server: ` (the URL must be `https://accounts.google.com/...` with a single `redirect_uri` of `http://127.0.0.1:<port>/`; anything else is ignored).
- JsonRpcProcess must tolerate that non-JSON stdout line (route it to a `onTextLine` hook instead of failing framing).

- [ ] **Step 1: Fake ACP server** (`fake-acp-server.ts`, scenarios via `FAKE_SCENARIO`): `ready` (authenticated), `signin` (unauthenticated until `authenticate`, prints the auth line with a valid Google URL, then becomes authenticated), `turn` (session/prompt streams `agent_message_chunk` ×2, a `tool_call` + `tool_call_update` completed, then returns `{ stopReason: 'end_turn' }`), `permission` (sends `session/request_permission` with options `allow_once`/`reject_once` before finishing), `crash` (exits mid-turn), `cancel` (ends the turn with `stopReason: 'cancelled'` after `session/cancel`).
- [ ] **Step 2: Failing tests:** outgoing messages include `"jsonrpc":"2.0"`; initialize parses agentInfo and auth; the auth line triggers `onAuthUrl` with the URL and does not break framing; a malicious auth line (non-Google origin, extra redirect_uri) is ignored; permission round-trip returns the selected optionId; cancel notification sent.
- [ ] **Step 3–4: Implement, run tests. Step 5: Commit** `feat(server): acp client`.

---

### Task 2: Antigravity installer

**Files:** Create `apps/server/src/connect/antigravity-release.ts`, `apps/server/src/connect/antigravity-install.ts`; Test `apps/server/test/antigravity-install.test.ts`.

**Interfaces:**
- Produces: `resolveAntigravityRelease(platform, arch): { version: string; url: string; sha256: string; archiveBytes: number; executable: string } | null` (table for win32-x64, win32-arm64, darwin-arm64, darwin-x64, linux-x64, linux-arm64 from T3 Code, version 1.3.0; e.g. win32-x64 → `https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip`, sha256 `65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9`, executable `agy_acp_server.exe`).
- Produces: `installAntigravity(opts: { home: string; fetch?: typeof fetch; onProgress: (p: { phase: 'download' | 'verify' | 'extract'; fraction: number }) => void; signal: AbortSignal }): Promise<{ path: string; version: string }>` and `findInstalledAntigravity(home): { path: string; version: string } | null`.

- [ ] **Step 1: Failing tests** with a local `http` fixture server serving a small zip (made in the test with `tar -a -c -f`): progress fractions increase to 1; checksum mismatch → error "The download didn't finish. Try again." and the version folder is gone (Review Focus 1); abort mid-download → same cleanup; success → executable path exists and `findInstalledAntigravity` returns it; unsupported platform → null release.
- [ ] **Step 2–4: Implement** (stream to `<dir>.partial`, hash while writing, `tar -xf` into the folder, atomic rename; executable bit on non-Windows), **run tests. Step 5: Commit** `feat(server): antigravity installer`.

---

### Task 3: Antigravity adapter and wiring

**Files:** Create `apps/server/src/adapters/antigravity.ts`; Modify `apps/server/src/adapters/registry.ts` (factory + path from `findInstalledAntigravity`), `apps/server/src/health.ts` (Antigravity version = ACP `agentInfo.version`, latest = pinned release version, update when they differ), `apps/server/src/api.ts` + `apps/server/src/chats.ts` (remove the "Antigravity chats aren't supported yet." 400), `apps/server/src/main.ts`; Test `apps/server/test/antigravity-adapter.test.ts`.

**Interfaces:**
- Produces: `class AntigravityAdapter implements ProviderAdapter` with `constructor(opts: { exePath: string; spawn?: … })` plus `signIn(onUrl: (url: string) => void, signal: AbortSignal): Promise<void>` (runs `authenticate` with the first auth method and resolves when initialize reports authenticated) and `ping()`.
- Mapping: `session/new` → `session.started` (sessionRef = sessionId); first update → `turn.started`; `agent_message_chunk` → `message.delta` (messageId per turn), turn end → `message.completed` with the joined text then `turn.completed` (`stopReason: 'cancelled'` → `stopped`; `refusal`/`max_tokens` → `turn.completed`); `tool_call`/`tool_call_update` → `tool.call` (summary from `title`); `session/request_permission` → `request.opened` kind `permission` (summary = tool title), `allow` → the `allow_once` option, `deny` → `reject_once`, `{ reply }` → `reject_once`; process exit mid-turn → `error` "Antigravity stopped unexpectedly." (Review Focus 4). `readUsage` → `{ status: 'unavailable', message: 'Antigravity doesn't report its limits.' }` unless the agent sends usage in `session/update` (`usage_update`), then map to windows. `listModels` → `[]` (Antigravity picks its model). `resume` → `session/load`.
- History continue for Antigravity uses `session/load` with the conversation id from `conversation_summaries.db`; if the agent rejects it, return 409 "This Antigravity chat can't be continued here yet. Start a new chat in the same folder." (verify with the real server in Step 5).

- [ ] **Step 1: Failing tests** against the fake ACP server for every mapping row, permission allow/deny, cancel → `stopped`, crash → error then respawn on next send, signIn resolves after the auth URL callback in the `signin` scenario, health shows `signed_out` before sign-in and `connected` after.
- [ ] **Step 2–4: Implement and wire, run tests.**
- [ ] **Step 5: Real check (needs the user once):** install via Task 2 code into the real home, run `signIn` and open the printed Google link — **the user signs in in their browser** — then start a chat in a temp folder with "reply with the single word ok" and confirm Running → Review; try continuing one Antigravity history chat and record whether `session/load` accepts it. Record results.
- [ ] **Step 6: Commit** `feat(server): antigravity adapter`.

---

### Task 4: ConnectService and settings

**Files:** Create `apps/server/src/connect/service.ts`, `apps/server/src/settings.ts`; Modify `apps/server/src/store.ts` (table `settings(key TEXT PRIMARY KEY, value TEXT)`), `apps/server/src/api.ts`, `apps/server/src/main.ts`, `packages/shared/src/types.ts`; Test `apps/server/test/connect.test.ts`, `settings.test.ts`.

**Interfaces:**
- Produces (shared): `type ConnectPhase = 'idle' | 'installing' | 'signing_in' | 'signing_out' | 'updating' | 'error'`; `interface ConnectState { provider: ProviderId; phase: ConnectPhase; step: string | null /* e.g. "Downloading Codex…" */; progress: number | null; signInUrl: string | null; message: string | null; updatedAt: string }`; `ServerEvent` gains `{ type: 'connect.updated'; state: ConnectState }`; `interface Settings { onboarded: boolean; showChats: Record<ProviderId, boolean>; suggest: Record<ProviderId, boolean> }`.
- Produces: `class ConnectService` with `constructor(opts: { run: CommandRunner; npmPath: () => Promise<string | null>; antigravity: { install: typeof installAntigravity; adapter: () => Promise<AntigravityAdapter | undefined> }; openBrowser: (url: string) => void; monitor: ConnectionMonitor; registry: AdapterRegistry; onUpdate: (s: ConnectState) => void; home: string; now? })`, `install(id)`, `signIn(id)`, `signOut(id)`, `update(id)`, `cancel(id)`, `states()`. One operation per provider at a time (a second request → 409 "Codex is busy. Wait for it to finish or cancel it.").
  - install Claude/Codex: `npm install -g <pkg>@latest` with progress steps "Downloading <App>…" → "Installing" → done; then `registry.ensure(id)` and `monitor.check(id)`.
  - signIn Claude: spawn `claude auth login --claudeai`; Codex: `codex login`; capture the first `https://` URL printed (offer it as `signInUrl` for "Open the browser again"); poll status every 2 s (`claude auth status --json` → `loggedIn`; `codex login status` exit 0 and "Logged in") until signed in, then kill the login process if still running; 5-minute timeout (Review Focus 2).
  - signIn Antigravity: adapter `signIn` with `openBrowser(url)` and `signInUrl` set.
  - signOut: `claude auth logout`, `codex logout`; Antigravity: delete the agent's credentials via the agent if it exposes a logout method, otherwise report "Sign out of Antigravity in the Antigravity app." (verify in Task 3 Step 5 which applies).
  - update: npm `@latest` for Claude/Codex (the Codex app-server is recycled when idle, Plan 1 M8); Antigravity: install the newer pinned release when the table changes.
  - errors map to plain copy (Review Focus 3): npm missing → "Agent Kanban needs npm to install <App>. Install Node.js from nodejs.org, then try again."; `EACCES`/`EPERM` → the message in Review Focus 3; network → "Couldn't reach the download server. Check your connection and try again."
- Produces (routes): `GET /api/connect` → `ConnectState[]`; `POST /api/connect/:provider/(install|signin|signout|update|cancel)` → `202` + state; `GET /api/settings` → `Settings`; `PATCH /api/settings` → `Settings`. Settings defaults: `onboarded: false`, all `showChats`/`suggest` true. `suggest` excludes a provider from `suggest()`; `showChats` filters `/api/history` and `/api/projects` history.
- `openBrowser`: Windows `cmd /c start "" "<url>"` (URL quoted, only `https:` allowed), macOS `open`, Linux `xdg-open`.
- `main.ts` honours `AGENT_KANBAN_HOME` (default `os.homedir()`) for Agent Kanban's own data (`.agent-kanban/`: database, lock, Antigravity install). Provider homes (`~/.claude`, `~/.codex`) stay at the real home.

- [ ] **Step 1: Failing tests** with a fake `CommandRunner` (scripted stdout/exit codes) and fake timers: install success path + events; EACCES → message; npm missing → message; sign-in success when status flips; timeout after 5 minutes → signed out message and the login process killed (Review Focus 2); cancel kills; a second operation → 409; already signed in before signIn → immediate success without spawning login (Review Focus 5); openBrowser rejects non-https; settings round-trip and effect on `suggest`/history.
- [ ] **Step 2–4: Implement, run tests. Step 5: Commit** `feat(server): connect service and settings`.

---

### Task 5: Connections page actions

**Files:** Modify `apps/web/src/ui/connections/ConnectionsPage.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/state/reducer.ts` (`connect.updated`); Test `apps/web/test/connections.test.tsx`.

Behaviour (from `design/connections.js`): states Not installed → Install (progress bar + step text crossfade) → Signed out → Sign in ("Finish signing in in your browser", "Open the browser again" when `signInUrl`, Cancel) → Connected (version, chats found, usage, switches "Show its chats in Recent chats" and "Suggest it for new chats" → `PATCH /api/settings`, Check for updates / Update to x.y.z, Sign out with the confirm popover text from the design) and error with Try again; "More agents, coming later" cards with Notify me (local only) and "Something else?" (toast "Thanks. We've noted <name>"). The Antigravity card says "Uses Google's official Antigravity server."

- [ ] **Step 1–4: Tests for each state rendering from `ConnectState` + `ConnectionHealth`, button → route calls, confirm popover; implement; run. Step 5: Commit** `feat(web): connections actions`.

---

### Task 6: Onboarding

**Files:** Create `apps/web/src/ui/onboarding/Onboarding.tsx`; Modify `apps/web/src/ui/shell/App.tsx`; Test `apps/web/test/onboarding.test.tsx`.

Behaviour (from `design/onboarding.js`): shown when `settings.onboarded` is false; Welcome (mini board animation) → Connect (live rows from health + connect states with Install / Sign in inline; Continue needs one connected; Review Focus 5) → Bring in your chats (counts per provider from `/api/history`, projects found, "Show in sidebar" switches → settings, the read-only note) → Notifications (desktop + sound prefs, "Play it") → Ready (summary; Start your first chat opens New chat; Go to the board) → `PATCH /api/settings { onboarded: true }`. Settings menu item "Replay onboarding" sets onboarded false locally (no server write until finished).

- [ ] **Step 1–4: Tests (gating on settings, Continue disabled until one provider connected, finish writes onboarded, already-connected providers show Connected immediately), implement, run. Step 5: Commit** `feat(web): onboarding`.

---

### Task 7: End-to-end check with all three providers

**Files:** Modify `apps/server/scripts/e2e-real.ts` (Antigravity steps).

- [ ] **Step 1:** Start the built app on 3006, open it, go through onboarding with the real machine: Claude Code and Codex show Connected immediately (already signed in); Antigravity: Install (real download + checksum) → Sign in (**the user completes Google sign-in in the browser**) → Connected.
- [ ] **Step 2:** On the board, start one chat per provider in a temp folder with tiny prompts; approve any permission request; all three reach Review.
- [ ] **Step 3:** Cancel an Antigravity sign-in midway on a second profile directory (`AGENT_KANBAN_HOME` override pointing to a temp home) and confirm the 5-minute/Cancel path leaves no process (Review Focus 2).
- [ ] **Step 4:** Record results in the report. **Step 5: Commit** `test: end-to-end with claude, codex and antigravity`.

## Spec coverage

| Spec | Task |
|---|---|
| §4 Antigravity adapter over ACP, limits only if reported | 1, 3 |
| §6 Connect screen states and actions | 5 |
| §7 ConnectService installers, sign-in, 5-minute timeout, cancel | 2, 4 |
| §8 install / login failure copy and retry | 2, 4 |
| §11 Connections, onboarding (design revisions 3–4) | 5, 6 |
| Plan 1 ruling: health + versions for all providers | 3 |

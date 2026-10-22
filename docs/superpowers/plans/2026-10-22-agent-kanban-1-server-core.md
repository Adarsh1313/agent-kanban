# Agent Kanban Server Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Node server that runs Claude Code and Codex chats on their own harnesses, moves each chat through Running → Needs you → Review → Done, reads each provider's usage limits and existing chat history, and exposes it all over HTTP + WebSocket for the web app (Plan 2).

**Architecture:** One Node process. Provider adapters (Claude via the Agent SDK, Codex via `codex app-server` JSON-RPC) emit a common `AdapterEvent` stream; `ChatService` feeds each event through a pure column state machine, persists to SQLite, and broadcasts `ServerEvent`s over WebSocket. `UsageService` polls each provider's own usage source. History readers list existing chats from each provider's local files, read-only.

**Tech Stack:** Node ≥ 22 (dev machine: 25) running TypeScript by native type stripping; `node:sqlite`; `node:test`; `ws@8.22.0`; `@anthropic-ai/claude-agent-sdk@0.3.308`; `typescript@7.0.2` for `tsc --noEmit` only.

**Spec:** `docs/specs/2026-10-22-agent-kanban-design.md` (sections 3–8 and 11). Roadmap: `docs/superpowers/plans/2026-10-22-agent-kanban-roadmap.md`.

## Global Constraints

- Node ≥ 22. TypeScript runs unbuilt via type stripping: no `enum`, `namespace`, parameter properties or decorators; relative imports end in `.ts`. `tsconfig.json` sets `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `strict`.
- The server listens on `127.0.0.1` only, on a random free port, and every HTTP request and the WebSocket upgrade must carry the per-launch token (`Authorization: Bearer <token>` or `?token=` for the socket). Wrong or missing token → 401.
- The app never calls provider APIs with the user's subscription tokens. It drives the official `claude` binary (through the Agent SDK) and the official `codex` binary only.
- Provider history files are opened read-only and never written.
- Usage is read every 60 seconds, after every `turn.completed`, and on manual refresh; at most one read in flight per provider (a trigger during a read gets the in-flight promise).
- Suggestion score per provider = `min(fiveHourLeft, weeklyLeft)`; providers with no numbers rank last; ties go to the earlier 5-hour reset.
- The Claude usage call `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` is marked unstable in SDK 0.3.308: call it from exactly one function (`readClaudeUsage`) so a rename is a one-line fix.
- User-facing message strings follow `design/design-brief.md`: plain words, no "session", "turn", "JSON-RPC" (e.g. "Codex isn't signed in. Open Connections to sign in.").
- Code ported from T3 Code (MIT) starts with `// Ported from pingdotgg/t3code (MIT), <path>` and the repo gets `THIRD_PARTY_LICENSES` with T3 Code's license.

## Review Focus

1. **A chat that is also open in the provider's own app.** Resuming a Claude chat whose `.jsonl` was written in the last 15 seconds must be refused with "This chat is active in Claude Code right now. Try again when it's idle." — pinned in Task 8.
2. **Provider missing or signed out when a chat starts.** The chat must land in Needs you with reason `error` and a readable message, not crash the server — pinned in Task 8.
3. **Agent process dies mid-turn.** Codex app-server exiting must move every running Codex chat to Needs you / `error`, and the next action restarts the process — pinned in Task 6 and Task 8.
4. **Messy history files.** Corrupt JSONL lines, sessions with no title record, unreadable `.zst` files and paths with spaces (`file:///c%3A/AntiGravity%20files/...`) must be skipped or decoded, never abort the scan — pinned in Task 5.
5. **App restarts while chats are running.** On startup every chat stored as `running` becomes `needs_you` / `interrupted` — pinned in Task 8.

---

## File structure

```
package.json                     npm workspaces, scripts: test, typecheck
tsconfig.json
THIRD_PARTY_LICENSES
packages/shared/src/types.ts     every type shared by server and web (ProviderId, Chat, AdapterEvent, UsageReading, ServerEvent…)
apps/server/package.json
apps/server/src/columns.ts       pure column state machine
apps/server/src/store.ts         SQLite persistence
apps/server/src/usage/parse.ts   provider responses → UsageReading; suggestion
apps/server/src/usage/service.ts polling, dedupe, last-good on error
apps/server/src/history/claude.ts | codex.ts | antigravity.ts | index.ts
apps/server/src/adapters/adapter.ts   ProviderAdapter interface
apps/server/src/adapters/jsonrpc.ts   newline-delimited JSON-RPC over a child process
apps/server/src/adapters/codex.ts
apps/server/src/adapters/claude.ts
apps/server/src/chats.ts         ChatService
apps/server/src/binaries.ts      find claude / codex on PATH
apps/server/src/api.ts           HTTP routes + WebSocket
apps/server/src/main.ts          wires everything, prints the URL with the token
apps/server/test/**              one *.test.ts per module, fixtures under test/fixtures
```

---

### Task 1: Workspace, shared types and the column state machine

**Files:**
- Create: `package.json`, `tsconfig.json`, `THIRD_PARTY_LICENSES`, `packages/shared/package.json`, `packages/shared/src/types.ts`, `apps/server/package.json`, `apps/server/src/columns.ts`
- Test: `apps/server/test/columns.test.ts`

**Interfaces:**
- Produces (in `packages/shared/src/types.ts`):
  - `type ProviderId = 'claude' | 'codex' | 'antigravity'`
  - `type Column = 'running' | 'needs_you' | 'review' | 'done'`
  - `type NeedsReason = 'permission' | 'question' | 'limit' | 'error' | 'interrupted' | 'stopped'`
  - `interface ChatState { column: Column; needsReason: NeedsReason | null }`
  - `type AdapterEvent` — exactly the union in spec section 4 (`turn.started`, `message.delta`, `message.completed`, `tool.call`, `request.opened`, `turn.completed`, `limit.reached`, `error`), plus `{ type: 'session.started'; sessionRef: string }` and `{ type: 'stopped'; sessionRef: string }`.
  - `type UserAction = { type: 'user.message' } | { type: 'user.answered' } | { type: 'user.stop' } | { type: 'user.markDone' } | { type: 'user.dragOut' } | { type: 'app.restarted' }`
- Produces (in `columns.ts`): `nextState(current: ChatState, event: AdapterEvent | UserAction): ChatState`

- [ ] **Step 1: Scaffold.** Root `package.json` with `"private": true`, `"type": "module"`, `"workspaces": ["apps/*", "packages/*"]`, scripts `"test": "node --test \"apps/*/test/**/*.test.ts\""` and `"typecheck": "tsc -p tsconfig.json"`; devDependencies `typescript@7.0.2`, `@types/node@26.6.5`. `tsconfig.json` per Global Constraints with `"module": "nodenext"`, `"target": "es2024"`, `"include": ["apps/*/src", "packages/*/src"]` (tests run but are not type-checked). `THIRD_PARTY_LICENSES` with T3 Code's MIT text from `https://github.com/pingdotgg/t3code/blob/main/LICENSE`. Run `npm install`.

- [ ] **Step 2: Write the failing test** — one `test()` per row of spec section 5 plus the stop rule from the design:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextState } from '../src/columns.ts';
const S = (column, needsReason = null) => ({ column, needsReason });
const ref = { sessionRef: 's1' };

test('user message → running', () => assert.deepEqual(nextState(S('review'), { type: 'user.message' }), S('running')));
test('request.opened permission → needs_you/permission', () =>
  assert.deepEqual(nextState(S('running'), { type: 'request.opened', ...ref, requestId: 'r', kind: 'permission', summary: '' }), S('needs_you', 'permission')));
test('request.opened question → needs_you/question', () =>
  assert.deepEqual(nextState(S('running'), { type: 'request.opened', ...ref, requestId: 'r', kind: 'question', summary: '' }), S('needs_you', 'question')));
test('limit.reached → needs_you/limit', () => assert.deepEqual(nextState(S('running'), { type: 'limit.reached', ...ref }), S('needs_you', 'limit')));
test('error → needs_you/error', () => assert.deepEqual(nextState(S('running'), { type: 'error', ...ref, message: 'x' }), S('needs_you', 'error')));
test('turn.completed → review', () => assert.deepEqual(nextState(S('running'), { type: 'turn.completed', ...ref }), S('review')));
test('turn.completed while a request is open stays in needs_you', () =>
  assert.deepEqual(nextState(S('needs_you', 'permission'), { type: 'turn.completed', ...ref }), S('needs_you', 'permission')));
test('user answered → running', () => assert.deepEqual(nextState(S('needs_you', 'question'), { type: 'user.answered' }), S('running')));
test('user stop → needs_you/stopped', () => assert.deepEqual(nextState(S('running'), { type: 'user.stop' }), S('needs_you', 'stopped')));
test('mark done → done', () => assert.deepEqual(nextState(S('review'), { type: 'user.markDone' }), S('done')));
test('agent events never move a card out of done', () => {
  for (const e of [{ type: 'turn.completed', ...ref }, { type: 'error', ...ref, message: 'x' }, { type: 'turn.started', ...ref }])
    assert.deepEqual(nextState(S('done'), e), S('done'));
});
test('dragging out of done → review', () => assert.deepEqual(nextState(S('done'), { type: 'user.dragOut' }), S('review')));
test('restart: running → needs_you/interrupted; others unchanged', () => {
  assert.deepEqual(nextState(S('running'), { type: 'app.restarted' }), S('needs_you', 'interrupted'));
  assert.deepEqual(nextState(S('review'), { type: 'app.restarted' }), S('review'));
});
test('message deltas and tool calls do not change the column', () =>
  assert.deepEqual(nextState(S('running'), { type: 'tool.call', ...ref, toolCallId: 't', name: 'Edit', summary: '', status: 'running' }), S('running')));
```

- [ ] **Step 3: Run it to verify it fails.** Run: `npm test` — Expected: FAIL, cannot find `../src/columns.ts`.

- [ ] **Step 4: Implement `nextState` in `apps/server/src/columns.ts`.** A `switch` on `event.type`; `user.message` also moves a `done` card to `running` (the only way out of done besides `user.dragOut`).

- [ ] **Step 5: Run tests and typecheck.** Run: `npm test && npm run typecheck` — Expected: all 14 pass, no type errors.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(server): workspace, shared types, column state machine"`

---

### Task 2: SQLite store

**Files:**
- Create: `apps/server/src/store.ts`
- Test: `apps/server/test/store.test.ts`

**Interfaces:**
- Consumes: `ProviderId`, `Column`, `NeedsReason` (Task 1).
- Produces (types added to `packages/shared/src/types.ts`):
  - `interface Chat { id: string; provider: ProviderId; sessionRef: string | null; cwd: string; title: string; model: string | null; column: Column | null; needsReason: NeedsReason | null; createdAt: string; updatedAt: string; doneAt: string | null; archived: boolean; pinned: boolean; snoozedUntil: string | null }` — `column: null` = only in the provider's history (spec section 11).
  - `interface Message { id: string; chatId: string; role: 'user' | 'assistant'; text: string; createdAt: string }`
  - `interface ToolCall { id: string; chatId: string; name: string; summary: string; status: 'running' | 'done' | 'failed'; createdAt: string }`
- Produces (in `store.ts`): `class Store` with `constructor(path: string)` (`':memory:'` for tests) and:
  `createChat(input: { provider; cwd; title; model?; sessionRef? }): Chat`, `getChat(id): Chat | undefined`, `listChats(): Chat[]` (newest `updatedAt` first, excludes archived), `updateChat(id, patch: Partial<Chat>): Chat` (always bumps `updatedAt`), `findBySessionRef(provider, sessionRef): Chat | undefined`, `addMessage(chatId, role, text): Message`, `appendToMessage(messageId, delta): void`, `listMessages(chatId): Message[]`, `upsertToolCall(t: Omit<ToolCall, 'createdAt'>): void`, `saveUsage(reading: UsageReading): void`, `lastUsage(provider): UsageReading | undefined`.

- [ ] **Step 1: Write the failing tests:**
  - `createChat` returns `column: 'running'`, `archived: false`, and a `title` of the first line of the prompt cut to 60 characters (spec section 5) when given `title: 'Line one that is quite long … (70 chars)\nsecond'`.
  - `updateChat` changes `updatedAt` and persists across a second `Store` on the same file (use a temp file under `os.tmpdir()`).
  - `listChats` order: three chats updated in sequence come back newest first; an archived one is absent.
  - `findBySessionRef('claude', 's1')` finds the chat after `updateChat(id, { sessionRef: 's1' })`.
  - `addMessage` + two `appendToMessage` calls → `listMessages` returns one message with the concatenated text.
  - `saveUsage` then `lastUsage('codex')` round-trips a reading with two windows.
- [ ] **Step 2: Run to verify they fail.** `npm test` — FAIL, `Store` not defined.
- [ ] **Step 3: Implement `Store`.** `new DatabaseSync(path)`; tables from spec section 5 (`chats`, `messages`, `tool_calls`, `requests`, `usage_snapshots`) plus `chats.archived`, `chats.pinned`, `chats.snoozed_until`, `chats.model`; `usage_snapshots.windows` as JSON text. Ids via `crypto.randomUUID()`. Timestamps ISO strings. `PRAGMA journal_mode = WAL`.
- [ ] **Step 4: Run tests.** `npm test` — all pass.
- [ ] **Step 5: Commit.** `git commit -am "feat(server): sqlite store"`

---

### Task 3: Usage parsing and suggestion

**Files:**
- Create: `apps/server/src/usage/parse.ts`
- Test: `apps/server/test/usage-parse.test.ts`

**Interfaces:**
- Produces (types in `packages/shared/src/types.ts`):
  - `interface UsageWindow { kind: 'five_hour' | 'weekly' | 'model'; label: string; leftPct: number; resetsAt: string | null }` (`leftPct` 0–100, rounded)
  - `interface UsageReading { provider: ProviderId; status: 'ok' | 'unavailable' | 'signed_out' | 'error'; windows: UsageWindow[]; readAt: string; message?: string }`
- Produces (in `parse.ts`):
  - `claudeUsageToReading(r: { rate_limits_available: boolean; rate_limits: null | Record<string, { utilization: number | null; resets_at: string | null } | null | undefined> }, now: Date): UsageReading` — SDK utilization is "percentage used, 0–100". `five_hour` → five_hour; `seven_day` → weekly (label `Weekly`); `seven_day_opus` → model `Opus · weekly`; `seven_day_sonnet` → model `Sonnet · weekly`; other keys ignored. `rate_limits_available: false` → `status: 'unavailable'`, no windows.
  - `codexLimitsToReading(r: { rateLimits: CodexSnapshot; rateLimitsByLimitId?: Record<string, CodexSnapshot> | null }, now: Date): UsageReading` where `CodexSnapshot = { limitId: string | null; limitName: string | null; primary: CodexWindow | null; secondary: CodexWindow | null }` and `CodexWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }` (epoch seconds, from `codex app-server generate-ts`, CLI 0.163.0). A window with `windowDurationMins <= 300` is five_hour, `>= 10080` is weekly. Extra snapshots in `rateLimitsByLimitId` (other than key `codex`) become model windows labelled `limitName`.
  - `suggest(readings: UsageReading[], allowed: ProviderId[]): ProviderId | null` — per Global Constraints.

- [ ] **Step 1: Write the failing tests:**
  - Claude: `{ rate_limits_available: true, rate_limits: { five_hour: { utilization: 28, resets_at: '2026-10-22T14:40:00Z' }, seven_day: { utilization: 42, resets_at: '2026-10-23T09:00:00Z' }, seven_day_opus: { utilization: 66, resets_at: null } } }` → windows `[five_hour 72, weekly 58, model 'Opus · weekly' 34]`, status `ok`.
  - Claude unavailable → `status: 'unavailable'`, `windows: []`.
  - Codex: primary `{ usedPercent: 69, windowDurationMins: 300, resetsAt: 1792680600 }`, secondary `{ usedPercent: 82, windowDurationMins: 10080, resetsAt: 1792944000 }` → five_hour 31 with `resetsAt` `new Date(1792680600 * 1000).toISOString()`, weekly 18.
  - Codex with `rateLimitsByLimitId: { codex: <same>, codex_mini: { limitName: 'Codex Mini', secondary: { usedPercent: 36, windowDurationMins: 10080, resetsAt: null } } }` → adds model window `Codex Mini` 64.
  - `suggest`: claude (72, 58), codex (31, 18), antigravity (88, 74) → `'antigravity'`; with `allowed: ['claude', 'codex']` → `'claude'`; antigravity `unavailable` and allowed all → `'claude'`; tie at 50/50 with resets 14:00 vs 15:00 → the 14:00 one; empty readings → `null`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement the three functions** (mark the Claude/Codex mapping with the T3 attribution header: logic follows `apps/server/src/provider/claudeUsageLimits.ts` and `codexUsageLimits.ts`).
- [ ] **Step 4: Run tests — all pass.**
- [ ] **Step 5: Commit.** `git commit -am "feat(server): usage parsing and provider suggestion"`

---

### Task 4: UsageService

**Files:**
- Create: `apps/server/src/usage/service.ts`
- Test: `apps/server/test/usage-service.test.ts`

**Interfaces:**
- Consumes: `UsageReading` (Task 3), `Store.saveUsage / lastUsage` (Task 2).
- Produces: `class UsageService` with `constructor(opts: { readers: Partial<Record<ProviderId, () => Promise<UsageReading>>>; store: Store; onUpdate: (r: UsageReading) => void; intervalMs?: number /* default 60_000 */; timeoutMs?: number /* default 15_000 */ })`, `start(): void`, `stop(): void`, `refresh(provider?: ProviderId): Promise<UsageReading[]>`, `latest(): UsageReading[]`.

- [ ] **Step 1: Write the failing tests** (use `mock.timers` from `node:test` for the interval):
  - `start()` reads every provider once immediately and again after 60 000 ms.
  - Two `refresh('codex')` calls while the first read is pending → the reader is called once and both promises resolve to the same reading.
  - A reader that throws after a good reading → `onUpdate` receives the previous windows with `status: 'error'` and `message` "Couldn't read Codex usage. Showing the last numbers we had."; `store.lastUsage` still has the good windows.
  - A reader that never resolves → after `timeoutMs` the reading is `status: 'error'`, and the next `refresh` calls the reader again (a hung agent process must not block refreshes forever).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** Keep `inFlight: Map<ProviderId, Promise<UsageReading>>`; delete the entry in `finally`.
- [ ] **Step 4: Run tests — all pass.**
- [ ] **Step 5: Commit.** `git commit -am "feat(server): usage polling service"`

---

### Task 5: History discovery (read-only)

**Files:**
- Create: `apps/server/src/history/claude.ts`, `codex.ts`, `antigravity.ts`, `index.ts`
- Test: `apps/server/test/history.test.ts`, fixtures in `apps/server/test/fixtures/{claude,codex,antigravity}/`

**Interfaces:**
- Produces (type in shared): `interface HistoryChat { provider: ProviderId; sessionRef: string; title: string; cwd: string; updatedAt: string }`
- Produces:
  - `readClaudeHistory(claudeHome: string): Promise<HistoryChat[]>` — scans `<claudeHome>/projects/*/*.jsonl`. `sessionRef` = file name without `.jsonl`; `title` = the last `{"type":"custom-title","customTitle":…}` record, else the first `user` record's text cut to 60 chars, else `Untitled chat`; `cwd` = the first record's `cwd`; `updatedAt` = file mtime.
  - `readCodexHistory(codexHome: string): Promise<HistoryChat[]>` — `<codexHome>/session_index.jsonl` lines `{ id, thread_name, updated_at }`; `cwd` from the first line (`type: 'session_meta'`, `payload.cwd`) of the rollout `sessions/**/rollout-*-<id>.jsonl.zst`, decompressed with `zlib.zstdDecompressSync`.
  - `readAntigravityHistory(dbPath: string): Promise<HistoryChat[]>` — `new DatabaseSync(dbPath, { readOnly: true })`, `SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries`; `workspace_uris` is a JSON array of `file:` URIs → first one through `fileURLToPath`.
  - `readAllHistory(home: string): Promise<HistoryChat[]>` — runs the three with default paths (`~/.claude`, `~/.codex`, `~/.gemini/antigravity/conversation_summaries.db`), a missing folder yields `[]`, results sorted newest first.

- [ ] **Step 1: Build fixtures.** Claude: a project folder with one titled session, one untitled session (title falls back to the first prompt), one file with a corrupt line in the middle. Codex: `session_index.jsonl` with two entries; one rollout `.jsonl.zst` (make it with `zlib.zstdCompressSync` in a `fixtures/make.ts` script committed alongside); the second entry has no rollout. Antigravity: a SQLite file created by the same script with one row whose `workspace_uris` is `["file:///c%3A/AntiGravity%20files/Parking%20lot"]`.
- [ ] **Step 2: Write the failing tests:**
  - Claude titled → `title: 'AI agent Kanban board'`; untitled → first prompt text; the corrupt line is skipped and the session still appears.
  - Codex → two chats; the one with a rollout has its `cwd`; the one without has `cwd: ''` and still appears.
  - Antigravity → `cwd` equals `fileURLToPath('file:///c%3A/AntiGravity%20files/Parking%20lot')` (on Windows `c:\AntiGravity files\Parking lot`).
  - `readAllHistory` on a temp home with no provider folders → `[]` and no throw.
  - The fixture files' bytes are unchanged after reading (hash before/after).
- [ ] **Step 3: Run to verify they fail.**
- [ ] **Step 4: Implement the four functions.** Read JSONL with `readline` over a `createReadStream`; wrap each `JSON.parse` in try/catch and skip bad lines.
- [ ] **Step 5: Run tests — all pass.** Then run once against the real home as a smoke check: `node -e "import('./apps/server/src/history/index.ts').then(m=>m.readAllHistory(require('os').homedir())).then(r=>console.log(r.length, r.slice(0,3)))"` — Expected: a count in the dozens, titles matching the provider apps.
- [ ] **Step 6: Commit.** `git commit -am "feat(server): read-only history discovery for claude, codex, antigravity"`

---

### Task 6: JSON-RPC client and Codex adapter

**Files:**
- Create: `apps/server/src/adapters/adapter.ts`, `apps/server/src/adapters/jsonrpc.ts`, `apps/server/src/adapters/codex.ts`
- Test: `apps/server/test/codex-adapter.test.ts`, `apps/server/test/fixtures/fake-codex-app-server.ts`

**Interfaces:**
- Consumes: `AdapterEvent`, `UsageReading`, `codexLimitsToReading` (Tasks 1, 3).
- Produces (`adapter.ts`), matching spec section 4:

```ts
export interface ProviderAdapter {
  id: ProviderId;
  startChat(input: { cwd: string; prompt: string; model?: string }): Promise<{ sessionRef: string }>;
  sendMessage(sessionRef: string, text: string): Promise<void>;
  respondToRequest(sessionRef: string, requestId: string, decision: 'allow' | 'deny' | { reply: string }): Promise<void>;
  stop(sessionRef: string): Promise<void>;
  resume(sessionRef: string, cwd: string): Promise<void>;
  onEvent(listener: (e: AdapterEvent) => void): () => void;
  readUsage(): Promise<UsageReading>;
  dispose(): Promise<void>;
}
```

- Produces (`jsonrpc.ts`): `class JsonRpcProcess` with `constructor(command: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv })`, `request<T>(method: string, params: unknown): Promise<T>`, `notify(method, params): void`, `onNotification(fn: (method: string, params: any) => void)`, `onRequest(fn: (method: string, params: any) => Promise<unknown>)` (server→client requests such as approvals), `onExit(fn: (code: number | null) => void)`, `close(): Promise<void>`. Framing: one JSON object per line on stdin/stdout. Codex omits `"jsonrpc": "2.0"`; send without it and accept messages with or without it.
- Produces (`codex.ts`): `class CodexAdapter implements ProviderAdapter` with `constructor(opts: { codexPath: string; spawn?: (cmd, args) => JsonRpcProcess })`.

Codex protocol (from `codex app-server generate-ts`, CLI 0.163.0): `initialize { clientInfo: { name: 'agent-kanban', version } }` then notification `initialized`; `thread/start { cwd, model?, approvalPolicy: 'on-request' }` → `{ thread: { id } }`; `turn/start { threadId, input: [{ type: 'text', text }] }` → `{ turn: { id } }`; `turn/interrupt { threadId, turnId }`; `thread/resume { threadId, cwd }`; `account/rateLimits/read` → `{ rateLimits, rateLimitsByLimitId }`. Notifications: `turn/started`, `item/started`, `item/agentMessage/delta { threadId, itemId, delta }`, `item/completed { item, threadId }`, `turn/completed { threadId, turn: { status: 'completed' | 'interrupted' | 'failed' } }`, `account/rateLimits/updated`. Server requests: `item/commandExecution/requestApproval { threadId, itemId, command }` and `item/fileChange/requestApproval` answered with `{ decision: 'accept' | 'decline' }`.

Event mapping: `turn/started` → `turn.started`; `item/agentMessage/delta` → `message.delta`; `item/completed` with `item.type === 'agentMessage'` → `message.completed`; `item/started|completed` with `item.type === 'commandExecution'` → `tool.call` (`summary: 'Running <command>'`), `item.type === 'fileChange'` → `tool.call` (`summary: 'Editing <first path>'`); approval request → `request.opened` (`kind: 'permission'`, `summary: command`) and the request's promise resolves when `respondToRequest` is called; `turn/completed` status `completed` → `turn.completed`, `interrupted` → `stopped`, `failed` → `error` with `turn.error.message`; `rateLimitReachedType` non-null on `account/rateLimits/updated` → `limit.reached`. `sessionRef` = `threadId`.

- [ ] **Step 1: Write the fake app-server.** `fixtures/fake-codex-app-server.ts` reads lines from stdin, answers `initialize`, `thread/start` (`{ thread: { id: 'thr_1' } }`), `turn/start` (`{ turn: { id: 'turn_1' } }`) and then emits `turn/started`, two `item/agentMessage/delta`, an `item/completed` agentMessage, and `turn/completed`. An env var `FAKE_SCENARIO` switches to: `approval` (sends `item/commandExecution/requestApproval` and waits for the answer before completing), `crash` (exits with code 1 after `turn/started`), `limits` (answers `account/rateLimits/read` with the Task 3 fixture).
- [ ] **Step 2: Write the failing tests** (spawn the fake with `process.execPath, [fakePath]`):
  - Happy path → events in order `session.started`, `turn.started`, `message.delta` ×2, `message.completed` (text = both deltas), `turn.completed`; `startChat` resolves `{ sessionRef: 'thr_1' }`.
  - `approval` → a `request.opened` event; calling `respondToRequest('thr_1', id, 'allow')` sends `{ decision: 'accept' }` and the turn completes.
  - `crash` → an `error` event with message "Codex stopped unexpectedly." for `thr_1`; the next `sendMessage` spawns a new process (count spawns via the injected `spawn`).
  - `stop('thr_1')` during a turn sends `turn/interrupt { threadId: 'thr_1', turnId: 'turn_1' }`.
  - `limits` → `readUsage()` equals `codexLimitsToReading(fixture, now)` windows.
- [ ] **Step 3: Run to verify they fail.**
- [ ] **Step 4: Implement `JsonRpcProcess` then `CodexAdapter`.** One app-server process shared by all Codex chats, started lazily; track `turnId` per thread for `stop`.
- [ ] **Step 5: Run tests — all pass.**
- [ ] **Step 6: Commit.** `git commit -am "feat(server): json-rpc client and codex adapter"`

---

### Task 7: Claude adapter

**Files:**
- Create: `apps/server/src/adapters/claude.ts`
- Modify: `apps/server/package.json` (add `@anthropic-ai/claude-agent-sdk@0.3.308`)
- Test: `apps/server/test/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter` (Task 6), `claudeUsageToReading` (Task 3).
- Produces: `class ClaudeAdapter implements ProviderAdapter` with `constructor(opts: { claudePath: string; query?: typeof import('@anthropic-ai/claude-agent-sdk').query })` (inject a fake in tests), and `readClaudeUsage(q: Query): Promise<UsageReading>` as the only caller of the experimental usage method.

SDK usage: one streaming-input `query({ prompt: asyncIterableOfUserMessages, options: { cwd, model, resume?, pathToClaudeCodeExecutable: claudePath, permissionMode: 'default', canUseTool } })` per chat; `sendMessage` pushes onto that chat's input queue. Map SDK messages: `system` subtype `init` → `session.started` with `session_id`; first assistant output in a turn → `turn.started`; `assistant` text blocks → `message.completed`; `assistant` `tool_use` blocks → `tool.call` (`summary`: `Editing <file_path>` for Edit/Write, `Running <command>` for Bash, `Reading <file_path>` for Read, else the tool name); `result` → `turn.completed` (or `error` when `is_error`). `canUseTool` → emit `request.opened` (`kind: 'question'` for `AskUserQuestion`, else `permission`) and return a promise resolved by `respondToRequest` (`allow` → `{ behavior: 'allow', updatedInput: input }`, `deny` → `{ behavior: 'deny', message: 'The user declined.' }`). `stop` → `query.interrupt()` then emit `stopped`. `readUsage` uses any live query, else starts a short-lived one with an empty prompt stream, calls `readClaudeUsage`, and closes it.

- [ ] **Step 1: Write the failing tests** with a fake `query` that returns an async generator of canned SDK messages and records its options:
  - Options include `pathToClaudeCodeExecutable` = the given path and `cwd`; `startChat` resolves with the `session_id` from the `init` message.
  - Canned `assistant` with a `tool_use` `{ name: 'Edit', input: { file_path: 'signup.tsx' } }` → `tool.call` with `summary: 'Editing signup.tsx'`.
  - The fake calls `options.canUseTool('Bash', { command: 'npm test' })`; the adapter emits `request.opened`; `respondToRequest(…, 'deny')` resolves the call with `{ behavior: 'deny', message: 'The user declined.' }`.
  - `resume(sessionRef, cwd)` passes `resume: sessionRef`.
  - `readClaudeUsage` on a fake returning the Task 3 fixture → same windows as `claudeUsageToReading`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `ClaudeAdapter`.**
- [ ] **Step 4: Run tests — all pass.**
- [ ] **Step 5: Manual check against the real CLI.** `node apps/server/scripts/try-claude.ts "list the files here"` (a 20-line script that starts one chat in a temp folder and prints events) — Expected: `session.started`, a `tool.call`, `turn.completed`; then the same session id appears in `claude --resume`'s list.
- [ ] **Step 6: Commit.** `git commit -am "feat(server): claude adapter on the agent sdk"`

---

### Task 8: ChatService

**Files:**
- Create: `apps/server/src/chats.ts`
- Test: `apps/server/test/chats.test.ts`

**Interfaces:**
- Consumes: `Store` (2), `nextState` (1), `ProviderAdapter` (6), `UsageService.refresh` (4), `HistoryChat` (5).
- Produces (type in shared): `type ServerEvent = { type: 'chat.updated'; chat: Chat } | { type: 'message.delta'; chatId: string; messageId: string; text: string } | { type: 'message.completed'; chatId: string; message: Message } | { type: 'tool.call'; chatId: string; toolCall: ToolCall } | { type: 'request.opened'; chatId: string; requestId: string; kind: 'permission' | 'question'; summary: string } | { type: 'usage.updated'; reading: UsageReading } | { type: 'notification'; chatId: string; kind: 'permission' | 'question' | 'finished' | 'limit' | 'error' }`
- Produces: `class ChatService` with `constructor(opts: { store: Store; adapters: Partial<Record<ProviderId, ProviderAdapter>>; usage: UsageService; broadcast: (e: ServerEvent) => void; claudeHome: string; now?: () => Date })` and methods `start(input: { provider; cwd; prompt; model? }): Promise<Chat>`, `send(chatId, text): Promise<void>`, `answer(chatId, requestId, decision): Promise<void>`, `stop(chatId): Promise<void>`, `markDone(chatId): Chat`, `dragOutOfDone(chatId): Chat`, `archive(chatId): Chat`, `continueHistory(h: HistoryChat, text: string): Promise<Chat>`, `recoverAfterRestart(): void`.

- [ ] **Step 1: Write the failing tests** with a `FakeAdapter` (records calls, lets the test emit `AdapterEvent`s):
  - `start` creates a chat in `running`, calls `adapter.startChat`, stores `sessionRef`, broadcasts `chat.updated`.
  - Emitting `request.opened` → chat in `needs_you`/`permission`, broadcasts `request.opened` and a `notification` of kind `permission`.
  - Emitting `turn.completed` → `review`, a `notification` of kind `finished`, and `usage.refresh(provider)` called once.
  - `message.delta` ×2 then `message.completed` → one stored assistant message with the full text.
  - `stop` → `adapter.stop` called, chat `needs_you`/`stopped`.
  - **Review Focus 2:** adapter `startChat` rejects with an `Error('not signed in')` → chat `needs_you`/`error` and the stored assistant message reads "Codex isn't signed in. Open Connections to sign in."; the server does not throw.
  - **Review Focus 3:** an `error` event for a running chat → `needs_you`/`error` with a `notification` of kind `error`.
  - **Review Focus 5:** store holds two `running` chats and one `review`; `recoverAfterRestart()` → the two become `needs_you`/`interrupted`, the review one is unchanged.
  - **Review Focus 1:** `continueHistory` for a Claude chat whose `.jsonl` mtime is 5 s before `now()` rejects with "This chat is active in Claude Code right now. Try again when it's idle." and creates no chat; at 60 s it succeeds, calls `adapter.resume` then `send`, and the chat is `running` with the history title.
  - `markDone` from `review` → `done`; `dragOutOfDone` → `review`; agent events for a `done` chat leave it `done`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `ChatService`.** Every state change goes through `nextState`; map adapter `sessionRef` → chat with `store.findBySessionRef`. Error copy per provider: `${name} isn't signed in. Open Connections to sign in.` when the message matches `/sign|auth|login/i`, else `${name} stopped unexpectedly. Resume to try again.`
- [ ] **Step 4: Run tests — all pass.**
- [ ] **Step 5: Commit.** `git commit -am "feat(server): chat service wiring adapters to the board"`

---

### Task 9: HTTP + WebSocket API and entry point

**Files:**
- Create: `apps/server/src/binaries.ts`, `apps/server/src/api.ts`, `apps/server/src/main.ts`
- Modify: `apps/server/package.json` (add `ws@8.22.0`, `@types/ws@8.18.2`; script `"start": "node src/main.ts"`)
- Test: `apps/server/test/api.test.ts`

**Interfaces:**
- Consumes: `ChatService` (8), `UsageService` (4), `readAllHistory` (5), `suggest` (3).
- Produces:
  - `findBinary(name: 'claude' | 'codex'): Promise<string | null>` — `where.exe` on Windows, `which` elsewhere; returns the first path (prefer `.cmd` on Windows) or `null`.
  - `createApi(opts: { chats: ChatService; usage: UsageService; history: () => Promise<HistoryChat[]>; token: string }): { server: http.Server; broadcast: (e: ServerEvent) => void }`
  - Routes (JSON in/out, all require the token):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/chats` | — | `Chat[]` |
| GET | `/api/chats/:id/messages` | — | `Message[]` |
| POST | `/api/chats` | `{ provider, cwd, prompt, model? }` | `201` + `Chat` |
| POST | `/api/chats/:id/messages` | `{ text }` | `204` |
| POST | `/api/chats/:id/requests/:requestId` | `{ decision: 'allow' \| 'deny' \| { reply } }` | `204` |
| POST | `/api/chats/:id/stop` · `/done` · `/undone` · `/archive` | — | `Chat` |
| GET | `/api/history` | — | `HistoryChat[]` |
| POST | `/api/history/continue` | `{ provider, sessionRef, text }` | `Chat` |
| GET | `/api/usage` | — | `{ readings: UsageReading[]; suggested: ProviderId \| null }` |
| POST | `/api/usage/refresh` | — | same as GET |
| WS | `/ws?token=` | — | stream of `ServerEvent` |

  Errors: `400 { error }` for bad bodies, `404` unknown chat, `409 { error }` for the "active elsewhere" refusal, `401` without the token.
- `main.ts`: token = `crypto.randomBytes(24).toString('hex')`; find binaries; build adapters only for binaries found; `chats.recoverAfterRestart()`; `usage.start()`; listen on `127.0.0.1:0`; print `Agent Kanban server: http://127.0.0.1:<port>/?token=<token>`. Database at `<home>/.agent-kanban/agent-kanban.db`.

- [ ] **Step 1: Write the failing tests** (build the API with fake services; `listen(0)`; use `fetch` and the `ws` client):
  - No token → `401` on `/api/chats` and on the WebSocket upgrade.
  - `POST /api/chats` with a valid body → `201` with the `Chat` JSON, and a `chat.updated` arrives on the socket.
  - `POST /api/chats` with `{ provider: 'nope' }` → `400 { error }`.
  - `POST /api/history/continue` where the service throws the active-elsewhere error → `409` with that message.
  - `GET /api/usage` → `{ readings, suggested }` where `suggested` equals `suggest(readings, all)`.
  - The server address is `127.0.0.1`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `findBinary`, `createApi`, `main.ts`.** Plain `node:http` routing with a small `match(method, pattern)` helper; `ws` `WebSocketServer({ noServer: true })` on `upgrade`.
- [ ] **Step 4: Run tests — all pass, then `npm run typecheck`.**
- [ ] **Step 5: End-to-end check with the real CLIs.** `npm start -w apps/server`, then with the printed token:
  - `curl -H "Authorization: Bearer $T" -X POST localhost:<port>/api/chats -d '{"provider":"codex","cwd":"<temp dir>","prompt":"create hello.txt with hi"}'` — Expected: a WebSocket client (`npx wscat -c "ws://127.0.0.1:<port>/ws?token=$T"`) shows `chat.updated` (running) → `request.opened` or `tool.call` → `chat.updated` (review); `hello.txt` exists.
  - Same with `"provider":"claude"`.
  - `GET /api/usage` shows Claude and Codex windows matching `/usage` in Claude Code and `/status` in Codex.
  - `GET /api/history` lists this machine's chats with the same titles as the provider apps.
- [ ] **Step 6: Commit.** `git commit -am "feat(server): http and websocket api, entry point"`

---

### Task 10: Connection health and version checks

Added after plan review: "keep no loose ends with connections; keep checking that the latest version is installed and the connection is strong."

**Files:**
- Create: `apps/server/src/health.ts`
- Modify: `apps/server/src/adapters/adapter.ts` (add `ping()`), `codex.ts`, `claude.ts`, `apps/server/src/api.ts` (route + event), `apps/server/src/main.ts` (start the monitor)
- Test: `apps/server/test/health.test.ts`

**Interfaces:**
- Consumes: `findBinary` (9), `ProviderAdapter` (6), `ServerEvent` (8).
- Produces:
  - `ProviderAdapter.ping(): Promise<{ ok: boolean; signedIn: boolean | null; message?: string }>` — Codex: `account/read` on the running app-server (starting it if needed) → `{ account: Account | null }`; `signedIn = account !== null`. Claude: `query(...).accountInfo()` on a short-lived query → `AccountInfo`; `signedIn = !!info.tokenSource && info.tokenSource !== 'none'` (same rule T3 Code uses).
  - (type in shared) `interface ConnectionHealth { provider: ProviderId; installed: boolean; path: string | null; version: string | null; latestVersion: string | null; updateAvailable: boolean; signedIn: boolean | null; processOk: boolean; status: 'connected' | 'update_available' | 'signed_out' | 'not_installed' | 'degraded'; message: string | null; checkedAt: string }`
  - `class ConnectionMonitor` with `constructor(opts: { providers: ProviderId[]; findBinary; getVersion: (id, path) => Promise<string | null>; getLatest: (id) => Promise<string | null>; adapters; onUpdate: (h: ConnectionHealth) => void; now?; healthMs?: number /* 60_000 */; versionMs?: number /* 6 h */ })`, `start()`, `stop()`, `check(provider?): Promise<ConnectionHealth[]>`, `latest(): ConnectionHealth[]`.
  - `getVersion`: runs `<path> --version` and takes the first `\d+\.\d+\.\d+` (`2.1.308 (Claude Code)` → `2.1.308`, `codex-cli 0.163.0` → `0.163.0`).
  - `getLatest`: `GET https://registry.npmjs.org/<pkg>/latest` → `.version`, where `pkg` is `@anthropic-ai/claude-code` or `@openai/codex`; network failure → `null` (never an error state on its own).
  - `ServerEvent` gains `{ type: 'connection.updated'; health: ConnectionHealth }`; API gains `GET /api/connections` and `POST /api/connections/check`.
  - Status precedence: `not_installed` > `signed_out` > `degraded` (ping failed, binary present) > `update_available` > `connected`. Messages: "Codex isn't installed.", "Codex isn't signed in.", "Codex didn't respond. Restarting it…", "Codex 0.164.0 is available (you have 0.163.0)."
  - Codex app-server keep-alive: `CodexAdapter` restarts a process that exits unexpectedly on the next ping or action, with backoff 1 s, 2 s, 4 s … capped at 60 s; after 3 failures in a row the status stays `degraded` until a manual check succeeds.

- [ ] **Step 1: Write the failing tests** (fake `findBinary`, `getVersion`, `getLatest`, adapters):
  - Installed 0.163.0, latest 0.163.0, ping ok + signed in → `status: 'connected'`, `updateAvailable: false`.
  - Latest 0.164.0 → `update_available` with the message above.
  - `getLatest` rejects (offline) → `latestVersion: null`, status still `connected`.
  - `findBinary` → `null` → `not_installed`; ping is not called.
  - Ping `{ ok: true, signedIn: false }` → `signed_out`.
  - Ping rejects → `degraded`, `processOk: false`; `onUpdate` called once per change, not on every identical check.
  - With `mock.timers`: health checks every 60 000 ms; the registry is queried at start and then every 6 h, not every minute.
  - Codex adapter: the fake app-server in `crash` scenario exits; three consecutive pings respawn after 1 s, 2 s, 4 s (count spawns with mocked timers).
  - `getVersion` parses both real formats above.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `ping()` in both adapters, the Codex backoff, and `ConnectionMonitor`; wire route, event and `start()` in `main.ts`.**
- [ ] **Step 4: Run tests — all pass; `npm run typecheck`.**
- [ ] **Step 5: Real check.** Start the server; `GET /api/connections` → Claude `2.1.308` and Codex `0.163.0`, both `connected`, `updateAvailable: false` (as of 2026-10-22). Kill the Codex app-server process from Task Manager → within 60 s a `connection.updated` with `degraded`, then `connected` after the respawn.
- [ ] **Step 6: Commit.** `git commit -am "feat(server): connection health and version monitor"`

---

## Spec coverage (Plan 1 vs spec)

| Spec section | Covered by |
|---|---|
| 3 Architecture: local server, token, 127.0.0.1, SQLite | Tasks 2, 9 |
| 4 Adapters: Claude, Codex; usage sources | Tasks 6, 7 (Antigravity → Plan 3) |
| 5 Data + column state machine | Tasks 1, 2, 8 |
| 6 Screens | Plan 2 |
| 7 UsageService, ChatService | Tasks 3, 4, 8 · ConnectService → Plan 3 |
| 8 Errors | Tasks 4, 6, 8 |
| 10 Testing: unit, adapter contract tests with fake processes, manual e2e | Every task; Tasks 6, 7, 9 manual checks |
| 11 History, same-chat resume, project → providers | Tasks 5, 8, 9 (project grouping and filters are UI → Plan 2) |
| Connection health and latest-version checks (added at plan review) | Task 10 |

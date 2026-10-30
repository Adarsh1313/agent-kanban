# Agent Kanban — MVP Design

Date: 2026-10-22
Status: Draft for review

## 1. Purpose

A local desktop app where every AI coding chat is a card on a Kanban board. Users start chats on
Claude Code, Codex, or Antigravity, continue them to completion inside the app, and see how much of
each provider's 5-hour and weekly limit is left so they can put work where there is room.

Target user: non-technical or semi-technical people. Setup must not require a terminal.

Success criteria for the MVP:

1. A new user installs the app, connects at least one provider from the Connect screen, and starts a
   chat without opening a terminal.
2. Chats on all three providers can be started, continued, approved/denied, and stopped from the app.
3. Cards move between columns automatically as the agent's state changes.
4. Usage for Claude and Codex is shown and refreshed within 60 seconds; the New Chat picker suggests a
   provider from that data.

## 2. Principles

- **Each provider runs on its own official harness.** The app drives the official `claude`, `codex`, and
  `agy` binaries. It never holds or calls provider APIs with the user's subscription tokens itself.
- **The official binary owns login.** The app only starts the binary's own sign-in and opens the URL it
  produces in the browser.
- **Ported, not vendored.** Logic is ported from T3 Code (MIT, github.com/pingdotgg/t3code) into plain
  TypeScript without the Effect runtime. Ported files carry an attribution header; the repo includes
  T3 Code's license in `THIRD_PARTY_LICENSES`.

## 3. Architecture

```
Electron shell
 └─ React UI (Vite)  ── WebSocket (events) + HTTP (commands) ──  Local server (Node, TypeScript)
                                                                  ├─ Provider adapters
                                                                  │   ├─ ClaudeAdapter  (Claude Agent SDK → user's `claude`)
                                                                  │   ├─ CodexAdapter   (`codex app-server`, JSON-RPC over stdio)
                                                                  │   └─ AntigravityAdapter (`agy` over ACP)
                                                                  ├─ ChatService (state machine, column logic)
                                                                  ├─ UsageService (polling + suggestion)
                                                                  ├─ ConnectService (detect / install / sign in)
                                                                  └─ Store (SQLite via node:sqlite)
```

The server listens on `127.0.0.1` only, on a random free port, and requires a per-launch token that the
Electron shell passes to the UI. During development the UI can run in a normal browser against the
server.

Runtime: Node 22+ (`node:sqlite`). Package manager: npm workspaces. Layout:

```
apps/server     local server
apps/web        React UI
apps/desktop    Electron shell (last MVP step)
packages/shared types shared by server and UI (events, DTOs)
```

## 4. Provider adapters

All adapters implement one interface so the rest of the app is provider-agnostic:

```ts
interface ProviderAdapter {
  id: "claude" | "codex" | "antigravity";
  startChat(input: { cwd: string; prompt: string }): Promise<{ sessionRef: string }>;
  sendMessage(sessionRef: string, text: string): Promise<void>;
  respondToRequest(sessionRef: string, requestId: string, decision: "allow" | "deny" | { reply: string }): Promise<void>;
  stop(sessionRef: string): Promise<void>;
  resume(sessionRef: string, cwd: string): Promise<void>; // reattach after app restart
  onEvent(listener: (e: AdapterEvent) => void): () => void;
  readUsage(): Promise<UsageReading>;
}

type AdapterEvent =
  | { type: "turn.started"; sessionRef: string }
  | { type: "message.delta"; sessionRef: string; messageId: string; text: string }
  | { type: "message.completed"; sessionRef: string; messageId: string; role: "assistant"; text: string }
  | { type: "tool.call"; sessionRef: string; toolCallId: string; name: string; summary: string; status: "running" | "done" | "failed" }
  | { type: "request.opened"; sessionRef: string; requestId: string; kind: "permission" | "question"; summary: string }
  | { type: "turn.completed"; sessionRef: string }
  | { type: "limit.reached"; sessionRef: string; resetsAt?: string }
  | { type: "error"; sessionRef: string; message: string };
```

| Adapter | Session | Resume | Usage source |
|---|---|---|---|
| Claude | Claude Agent SDK `query()` with `pathToClaudeCodeExecutable` = detected `claude` binary | SDK `resume` with stored session id | SDK usage control request (`five_hour`, `seven_day` windows) |
| Codex | `codex app-server` child process, one per app; one thread per chat | `thread/resume` with stored thread id | `account/rateLimits/updated` notifications, plus an explicit rate-limit read on poll |
| Antigravity | ACP session over the `agy` binary | ACP session load with stored session id | Only if `agy` reports it through its own process; otherwise `unavailable` |

**Antigravity limits.** T3 Code reads `agy`'s OAuth token and calls Google's internal `cloudcode-pa`
API. Google's terms prohibit using an Antigravity login from third-party software, so this app does
not do that. Antigravity usage shows "Limits unavailable" unless `agy` exposes it itself.

**Claude subscription policy.** Anthropic's rules for Agent SDK use on Pro/Max subscriptions changed
several times in 2026. The Connect screen shows a one-line note linking to Anthropic's current terms.
Re-check before any public release.

## 5. Chats and columns

### Data

```
chats(id, provider, session_ref, cwd, title, column, needs_reason, created_at, updated_at, done_at)
messages(id, chat_id, role, text, created_at)              -- user + assistant
tool_calls(id, chat_id, name, summary, status, created_at)
requests(id, chat_id, kind, summary, status, created_at)   -- open | answered
usage_snapshots(provider, five_hour_pct_left, weekly_pct_left, five_hour_resets_at, weekly_resets_at, status, read_at)
```

`title` is the first line of the first prompt, truncated to 60 characters.

### Column state machine

Columns: `running`, `needs_you`, `review`, `done`.

| Event | New column | `needs_reason` |
|---|---|---|
| User starts a chat or sends a message | running | — |
| `turn.started` | running | — |
| `request.opened` | needs_you | `permission` or `question` |
| `limit.reached` | needs_you | `limit` (badge shows reset time) |
| `error` | needs_you | `error` |
| `turn.completed` with no open request | review | — |
| User answers a request | running | — |
| User marks done or drags to Done | done | — |

Rules:

- Only the user moves a card to `done`. An agent event never moves a card out of `done`, except a new
  user message, which moves it to `running`.
- Dragging a card between `running`, `needs_you`, and `review` is not allowed (those reflect agent
  state); dragging to and from `done` is allowed. Dragging out of `done` moves the card to `review`.
- On app restart, chats that were `running` become `needs_you` with reason `interrupted` and a
  "Resume" button.
- Within a column, cards are ordered by `updated_at`, newest first.

## 6. Screens

### Board (home)

Four columns. Each card shows: provider icon, title, folder name, time since last update, and for
`needs_you` the reason badge. A running card shows a live activity indicator and the latest tool call
summary. A header shows a compact usage strip (one meter per provider) and a "New chat" button.

### Chat (opens as a side panel over the board)

Message list with streaming assistant text, collapsed tool-call rows, inline Allow / Deny buttons or a
reply box for open requests, a composer, a Stop button while running, and a "Mark done" button.

### New chat (dialog)

1. Provider picker: one option per connected provider with its 5-hour and weekly remaining bars and
   reset times. The provider with the highest score has a "Suggested" tag and is preselected.
2. Folder picker: native folder dialog in Electron, a path input in browser dev mode. Recent folders are
   listed.
3. Prompt box. Submit creates the chat in `running` and opens its panel.

Disconnected providers appear disabled with a "Connect" link.

### Usage

One card per provider: 5-hour and weekly bars, reset countdowns, last-updated time, status
(`ok`, `unavailable`, `signed_out`, `error`). A Refresh button triggers an immediate read of all
providers.

### Connect

One card per provider. States and actions:

| State | Detected by | Action |
|---|---|---|
| Not installed | Binary not found on PATH or in the app's managed install dir | **Install** |
| Installing | Install in progress | Progress + cancel |
| Signed out | Binary found, auth probe fails | **Sign in** |
| Signing in | Login process running | "Finish in your browser" + cancel |
| Connected | Auth probe passes | Version + "Sign out" |
| Error | Last action failed | Message + retry |

## 7. Services

### UsageService

- Reads all connected providers every 60 seconds, after every `turn.completed`, and on manual refresh.
- At most one read in flight per provider; a trigger during a read is dropped.
- Each read writes a `usage_snapshots` row and broadcasts a `usage.updated` event.
- Suggestion score per provider = `min(five_hour_pct_left, weekly_pct_left)`. Providers with no
  numbers rank last. Ties go to the provider with the earlier 5-hour reset.

### ConnectService

Installers (all official sources, run without a terminal window):

| Provider | Install | Sign in | Auth probe |
|---|---|---|---|
| Claude | Official native installer (`install.ps1` on Windows, `install.sh` on macOS/Linux) | `claude auth login` | SDK initialization reports a token source |
| Codex | Official GitHub release archive into the app's managed dir (ported from T3 `CodexInstallation`) | `codex login` (ChatGPT browser flow) | `codex login status` |
| Antigravity | Official release download into the managed dir (ported from T3 `AntigravityInstallation`) | ACP authenticate; the sign-in URL is opened in the browser | ACP initialize reports authenticated |

Login processes open the system browser. The service streams their state to the UI and times out after
5 minutes.

### ChatService

Owns the state machine in section 5, persists adapter events, and broadcasts `chat.updated`,
`message.delta`, `message.completed`, `tool.call`, and `request.opened` over WebSocket.

## 8. Errors

- Adapter process exits unexpectedly: the chat moves to `needs_you` with reason `error` and a Resume
  button.
- Provider signed out mid-chat: `needs_you` with reason `error`, and the message links to Connect.
- Usage read fails: the snapshot keeps the last good numbers and sets `status = error`; the UI shows
  them dimmed with "Last updated N min ago".
- Install or login failure: the Connect card shows the error text and a Retry button.

## 9. Design system

The UI is built on a design system that is defined before UI implementation starts, as its own
deliverable (`docs/specs/design-system.md`). It covers color and type tokens, spacing, components, and
an explicit motion spec: card movement between columns, streaming text, live indicators, button and
drag feedback, dialog and panel transitions, and reduced-motion behavior. UI work in the implementation
plan depends on it.

## 10. Testing

- Unit: column state machine (every row in section 5), usage parsing for each provider, suggestion
  scoring, Connect state transitions.
- Adapter contract tests: each adapter runs against a fake process that replays recorded event streams.
- Manual end-to-end: real `claude` and `codex` on the developer's machine; Antigravity when `agy` is
  installed.

## 11. Revision: existing chats, projects and notifications

Decided after the first design review.

### Existing chats come from each provider's own history

Each provider keeps a local index of its chats with a title and project folder. The app reads these
(read-only) to fill the sidebar and the Projects list:

| Provider | Where | Title | Project |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<encoded cwd>/<session>.jsonl` | `custom-title` record, else the first prompt | `cwd` field in the records |
| Codex | `~/.codex/session_index.jsonl` (+ `sessions/YYYY/MM/DD/*.jsonl.zst`) | `thread_name` | `session_meta.cwd` in the rollout |
| Antigravity | `~/.gemini/antigravity/conversation_summaries.db` (SQLite) | `title` | `workspace_uris` |

Prefer the provider's own API when it exposes the same list (Codex app-server thread listing, ACP
session listing); fall back to these files. Verify the Antigravity CLI and IDE share this store.

### Continuing a chat continues the same chat

Opening a chat from the sidebar shows its history; sending a message resumes **the same session id**
(Claude SDK `resume`, Codex `thread/resume`, ACP session load), so the conversation stays one chat and
still appears in the provider's own app. We do not embed the provider's UI; we render the same
conversation. Don't resume a session that is active in the provider's app at the same moment (check
for recent writes / a lock first). Chats only in the provider's history are not on the board; sending
a message puts them there.

### Projects suggest a provider

A project lists the providers that have chats in it. New chat picks a project first and defaults to the
provider that already knows it, but any connected provider can start a chat in any folder (changed
2026-10-30, issue #22: the user works on the same local projects across Claude, Codex and Antigravity).

### Notifications replace the Needs you page

A bell in the top bar collects "needs you" and "finished" events, with switches for desktop
notifications and sound. The Needs you column stays.

### Filters

Linear-style filter menu: Provider, Project, Status, Model, Waiting on you for, Last activity, Started
in. Multi-select panes have Select all / None. Active filters show as removable chips. Clicking a
provider in the sidebar is a shortcut for "Provider is X" and shows only that provider's limits in the
top bar, with a "Usage for all providers" button.

### Chat actions (from T3 Code)

Open in <provider app>, Pin to sidebar, Snooze (1 hour / this evening / tomorrow / next week), Rename,
Copy project path, Archive chat. Archive and Snooze are undoable from a toast.

### Future, not designed or built: cross-provider handoff

Idea to revisit after using the product: each project keeps a progress and context file (for example
`PROGRESS.md`) that every provider reads first and updates when it finishes. That would let a project
started on Claude continue on Codex when Claude's limits run out, and keep each provider up to date
afterwards without re-explaining. Until then, providers are limited per project as above.

## 12. Out of scope for the MVP

Mobile, remote access, git worktrees and diff review, multiple accounts per provider, teams and
sharing, providers other than the three above, auto-update of the app.

# Agent Kanban — Build Roadmap

The spec (`docs/specs/2026-10-22-agent-kanban-design.md`) covers four pieces that can each ship and be
tested on their own. Each gets its own plan, written when the previous one lands, so later plans can
use the real interfaces instead of guessed ones.

| # | Plan | Delivers | Depends on |
|---|---|---|---|
| 1 | **Server core** (`2026-10-22-agent-kanban-1-server-core.md`) — done | Local Node server: Claude + Codex adapters, column state machine, SQLite store, usage polling and suggestion, read-only history discovery for all three providers, HTTP + WebSocket API | — |
| 2 | **Web app** (`2026-10-23-agent-kanban-2-web-app.md`) — done | The designed UI from `design/` as a React app on the Plan 1 API: board with live cards and FLIP moves, chat panel, New chat, usage chips and dropdown, filters, bell, sidebar, Projects page | Plan 1 |
| 3 | **Connect and Antigravity** (`2026-10-23-agent-kanban-3-connect-and-antigravity.md`) | Antigravity adapter (ACP over `agy`), install and sign-in flows for all three providers (Connections page), first-run onboarding | Plans 1–2 |
| 4 | **Desktop app** | Electron shell, per-launch token handoff, native folder picker, desktop notifications, Windows installer | Plans 1–3 |

Out of every plan: the cross-provider handoff idea (spec section 11, "Future"), mobile, teams.

## Design inputs for Plans 2–4

`design/tokens.css`, `design/components.css`, `design/views.css` are production-ready styles; the
prototypes (`design/board.html`, `projects.js`, `connections.js`, `onboarding.js`) are the behaviour
reference. `design/design-brief.md` holds copy and motion rules.

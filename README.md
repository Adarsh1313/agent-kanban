# Agent Kanban

A local app that puts every AI coding chat (Claude Code, Codex, Antigravity) on one Kanban board:
Running → Needs you → Review → Done. It drives each provider's own official app on your computer,
shows how much of each plan's 5-hour and weekly limits is left, and keeps checking that every
connection is healthy and up to date.

## Status

| Part | State |
|---|---|
| Server (`apps/server`) | Built: Claude Code + Codex chats, board state, usage limits, chat history, connection health, HTTP + WebSocket API |
| Design (`design/`) | Clickable prototype and design system |
| Web app (`apps/web`) | Built: board, chat panel, New chat, usage, filters, notifications, Projects and Connections pages |
| Connect and Antigravity | Built: Antigravity chats (Google's official ACP server), install / sign in / sign out / update for all three providers from the app, first-run onboarding |
| Desktop app | Plan 4 |

## Run it

Requires Node 22.18+. Claude Code, Codex and Antigravity can be installed and signed in from the app (Connections page or onboarding).

```bash
npm install
npm test
npm run build
AGENT_KANBAN_PORT=3006 npm start
```

The server prints a link with a one-time token. Open it to use Agent Kanban. The token changes on
every restart. For development, `npm run dev -w apps/web` runs Vite on 3005 against the server on 3006.

Design prototype:

```bash
python -m http.server 3007 --directory design
```

Then open http://localhost:3007/board.html.

## Docs

- Spec: `docs/specs/2026-10-22-agent-kanban-design.md`
- Roadmap and plans: `docs/superpowers/plans/`
- Design brief and tokens: `design/design-brief.md`, `design/tokens.css`

Parts of the provider integration logic are ported from [T3 Code](https://github.com/pingdotgg/t3code) (MIT); see `THIRD_PARTY_LICENSES`.

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
| Web app | Next (Plan 2) |
| Antigravity chats, install/sign-in flows | Plan 3 |
| Desktop app | Plan 4 |

## Run it

Requires Node 22.18+ and Claude Code and/or Codex installed and signed in.

```bash
npm install
npm test
AGENT_KANBAN_PORT=3006 node apps/server/src/main.ts
```

The server prints a URL with a one-time token. Open it in a browser to see a live console of
connections, usage, the board and your chat history.

Design prototype:

```bash
python -m http.server 3005 --directory design
```

Then open http://localhost:3005/board.html.

## Docs

- Spec: `docs/specs/2026-10-22-agent-kanban-design.md`
- Roadmap and plans: `docs/superpowers/plans/`
- Design brief and tokens: `design/design-brief.md`, `design/tokens.css`

Parts of the provider integration logic are ported from [T3 Code](https://github.com/pingdotgg/t3code) (MIT); see `THIRD_PARTY_LICENSES`.

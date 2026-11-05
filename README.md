# Agent Kanban

One board for all your AI agent chats. See what's running, what needs you and what's ready to review,
across Claude Code, Codex and Antigravity, without switching between apps or terminals.

You already pay for Claude, ChatGPT and Gemini plans. Agent Kanban puts every chat from all of them on one
simple Kanban board (Running → Needs you → Review → Done) so you can run many at once and get the most out of
every plan. It drives each provider's own official app on your computer, shows how much of each plan's 5-hour
and weekly limits is left, and keeps checking that every connection is healthy and up to date.

## Status

| Part | State |
|---|---|
| Server (`apps/server`) | Built: Claude Code + Codex chats, board state, usage limits, chat history, connection health, HTTP + WebSocket API |
| Design (`design/`) | Clickable prototype and design system |
| Web app (`apps/web`) | Built: board, chat panel, New chat, usage, filters, notifications, All chats, Projects and Connections pages |
| Connect and Antigravity | Built: Antigravity chats (Google's official ACP server), install / sign in / sign out / update for all three providers from the app, first-run onboarding |
| Desktop app (`apps/desktop`) | Built: Windows app with its own window and tray, per-user installer |

## Run it

Requires Node 22.18+. Claude Code, Codex and Antigravity can be installed and signed in from the app (Connections page or onboarding).

Everyday use on Windows: install **Agent Kanban** with `apps/desktop/dist/Agent Kanban Setup <version>.exe`
(no admin rights; Windows may warn that the app is unrecognised because it isn't signed: More info → Run anyway).
It opens in its own window; closing the window keeps it running in the tray, and **Quit Agent Kanban** in the
tray menu stops it and every chat. Your chats live in `~/.agent-kanban` and survive reinstalling.

Desktop app commands:

```bash
npm run desktop        # build the web app and run the desktop app from source
npm run desktop:dist   # build the installer into apps/desktop/dist
npm run desktop:icons  # re-render the app and tray icons from design/assets
```

The desktop app and browser mode (below) share `~/.agent-kanban`; only one runs at a time.

Development (browser mode):

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
- Design brief and tokens: `design/DESIGN.md`, `design/tokens.css`

Parts of the provider integration logic are ported from [T3 Code](https://github.com/pingdotgg/t3code) (MIT); see `THIRD_PARTY_LICENSES`.

# Backlog (order of work)

Updated 2026-10-30. GitHub issues carry the details; this file is the order. A fresh session resumes from here.

## 1. Desktop app (Plan 4): issue #20, now

Flow: `/grill-with-docs` → `/to-spec` (writes `docs/specs/desktop-app.md` with a `## Progress` checklist) → new session `/implement docs/specs/desktop-app.md`.

What already exists:
- **Launcher** (`scripts/desktop/`, `npm run desktop`, `desktop:stop`, `desktop:install`): builds the web app, starts the server on 3006 and has the server open its own page (`openLocalApp`, 127.0.0.1 only). The session token is never printed or written to a file.
- **Stop:** `stop.request` in the data folder stops the server cleanly.
- **Shortcuts:** "Agent Kanban" / "Stop Agent Kanban" on the Windows desktop, with Node's icon.
- **Server:** Node 25 with native TypeScript type stripping; serves `apps/web/dist`. Single-instance lock at `~/.agent-kanban/server.lock`. Graceful shutdown on SIGINT/SIGTERM/SIGHUP/SIGBREAK.
- **Native dialogs:** the server can already show them (`/api/folders/pick`, #24).

Questions for the grilling:
- **Shell:** Electron, Tauri, or the launcher + browser kept with a tray icon?
- **Node:** bundled Node vs the user's own install.
- **Windows-first?** And installer vs a portable app.
- **Autostart and tray:** start at login? What does closing the window do: stop, or keep running in the tray?
- **Second launch:** what happens when the app is already running (focus the existing window)?
- **Updating Agent Kanban itself:** git pull vs releases.
- **App icon and name.**
- **Open in app / Open folder (#15):** comes with this.
- **Hosted web idea (#18):** does the desktop app make it unnecessary?

Note: `design/` has `design-brief.md` + `tokens.css` but no `DESIGN.md`. If the desktop app needs new UI (tray menu, window chrome, icon), run `/design-grill` for those gaps.

## 2. Issues by severity (labels P1 → P3)

**Fixed on branch `fix/p1-issues` (2026-10-30):** #5, #8, #12, #4 (all of P1), #6, #9, #10, #7.

**Waiting on the user:**
- #21: update failure. Need the message the app showed; both updates worked when run directly.
- #11: temp test folders as projects. Hide by default, or clean up?

**Next, P3:**
- #13: Antigravity sign-in polish
- #14: Antigravity update while busy / old versions
- #16: past messages for imported chats
- #17: notifications id, burst cap, archive animation
- #19: small edge cases
- #18: hosted web (decide after the desktop app)

## Done, waiting to be merged

- Branch `fix/chat-layout-and-launcher`: #3 and the launcher.
- Branch `feat/any-provider-folders`: built on it, adds #22, #23, #24.
- Branch `fix/p1-issues`: built on that, adds #5 #8 #12 #4 #6 #9 #10 #7. Merging this one brings in all three.

Close those issues when they're merged.

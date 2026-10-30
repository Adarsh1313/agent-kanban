# Backlog (order of work)

Updated 2026-10-30. GitHub issues carry the details; this file is the order. A fresh session resumes from here.

## 1. Desktop app (Plan 4): issue #20, now

Flow: ~~`/grill-with-docs`~~ (done 2026-10-30) → `/design-grill` (app icon, tray icon, tray menu) → `/to-spec` (writes `docs/specs/desktop-app.md` with a `## Progress` checklist) → new session `/implement docs/specs/desktop-app.md`.

Decided in the grilling (why Electron: `docs/adr/0001-electron-desktop-shell.md`; terms: `GLOSSARY.md`):
- **Shell:** Electron; the server runs on Electron's own Node. **First slice:** prove `node:sqlite` + type stripping work there; fallback is a bundled Node binary for the server.
- **v1 is Windows only:** per-user NSIS installer (electron-builder), unsigned. Name "Agent Kanban".
- **Closing the window** hides it to the tray; chats keep running; the first close shows a one-time note. **Quit** (tray menu) asks first if chats are running, then stops the server cleanly.
- **Second launch** focuses the existing window. **Start at login:** off by default, switch in Settings.
- **Notification click** brings the window forward and opens that chat. Window size and position are remembered.
- **Open folder (#15)** is in v1; Open in app is later.
- **Browser mode** (`npm start`) stays for development, same data, one at a time (`server.lock`). The launcher scripts and the two desktop shortcuts are removed.
- **No self-update in v1.** When the repo goes public: a "New version → Download" link to GitHub Releases.
- **Later, before friends get it:** #26 provider installers without npm, then #25 Mac build, then make the repo public after a history scan. #18 closed (not planned).

What already exists:
- **Launcher** (`scripts/desktop/`, `npm run desktop`, `desktop:stop`, `desktop:install`): builds the web app, starts the server on 3006 and has the server open its own page (`openLocalApp`, 127.0.0.1 only). The session token is never printed or written to a file.
- **Stop:** `stop.request` in the data folder stops the server cleanly.
- **Shortcuts:** "Agent Kanban" / "Stop Agent Kanban" on the Windows desktop, with Node's icon.
- **Server:** Node 25 with native TypeScript type stripping; serves `apps/web/dist`. Single-instance lock at `~/.agent-kanban/server.lock`. Graceful shutdown on SIGINT/SIGTERM/SIGHUP/SIGBREAK.
- **Native dialogs:** the server can already show them (`/api/folders/pick`, #24); it already has macOS and Linux branches.

## 2. Issues by severity (labels P1 → P3)

**Fixed on branch `fix/p1-issues` (2026-10-30):** #5, #8, #12, #4 (all of P1), #6, #9, #10, #7.

**Waiting on the user:**
- #21: update failure. Need the message the app showed; both updates worked when run directly.
- #11: temp test folders as projects. Hide by default, or clean up?

**P3 (2026-10-30, branch `fix/p1-issues`):**
- **Done:**
  - #13: "Opening your browser…" step; start-failure copy in the design.
  - #16: past messages for Claude and Codex history chats.
  - #19: lock path in the "already running" message; NaN guard.
- **Left:**
  - #16 paging: only the last 200 messages are shown; Antigravity history isn't readable.
  - #19 remaining items.
  - #17: the archive animation belongs to the motion skills; the rest works as is.
  - #14: can't happen until the Antigravity pin moves.
  - #18: closed (not planned) in the desktop grilling.

**Desktop follow-ups (before friends get the app):** #26 install Claude Code / Codex without npm, then #25 Mac build.

## Done, waiting to be merged

- Branch `fix/chat-layout-and-launcher`: #3 and the launcher.
- Branch `feat/any-provider-folders`: built on it, adds #22, #23, #24.
- Branch `fix/p1-issues`: built on that, adds #5 #8 #12 #4 #6 #9 #10 #7, then #13 #16 #19. Merging this one brings in all three.

Close those issues when they're merged.

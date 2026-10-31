# Outside sessions live on the board

Built from `docs/specs/outside-sessions-decisions.md` (grilled 2026-10-31). Terms are in `GLOSSARY.md`. Closes #37 (feedback item 11).

## Problem Statement

The user often runs Claude Code directly in a terminal or the Claude app. Those chats only appear in Agent Kanban later, as history, so the board can't show what is running or what is waiting for them. They end up checking terminals one by one, which is exactly what the board was meant to stop.

## Solution

A one-click **Install** in Settings adds an Agent Kanban hook entry to `~/.claude/settings.json`. Claude Code then tells our local server when an **outside session** starts, needs the user and stops. Each one becomes a card that moves Running → Needs you → Review like our own chats. While it runs outside, the card is watch-only. Once it stops, **Continue here** resumes it in the app. **Remove** takes our entry out again.

## User Stories

1. As a user, I want an Install button in Settings under "Claude Code outside the app", so that I can turn this on without editing files.
2. As a user, I want Settings to say in one line what Install changes ("Adds Agent Kanban to Claude Code's settings so outside chats show on your board"), so that I know what I'm agreeing to.
3. As a user, I want Remove to take out only Agent Kanban's entry, so that my own hooks stay untouched.
4. As a user, I want Settings to show Installed or Not installed, and to notice if I removed the entry by hand, so that the state is never wrong.
5. As a user, I want a Claude Code chat I start in a terminal to appear on the board as Running within a second, so that I can see it without switching windows.
6. As a user, I want it to move to Needs you with "Wants permission" or "Waiting for you" when Claude Code asks for me, so that I go back to the terminal at the right time.
7. As a user, I want the needs-you bell, chime and tray dot to count outside sessions too, so that there is one signal for everything.
8. As a user, I want it to move to Review when Claude Code stops, so that I check its work like any other chat.
9. As a user, I want an outside card marked "Running outside the app" with the activity line and transcript readable in the panel, so that I can follow along.
10. As a user, I want the composer replaced by "This chat is running in Claude Code outside the app. Reply there, or continue here once it stops.", so that I never send into a chat I don't control.
11. As a user, I want Continue here on a stopped outside session, so that I can carry on in the app.
12. As a user, I want outside sessions in projects outside My projects to still get a card, plus the "New activity · Add" hint, so that nothing running is missed.
13. As a user, I want sessions that ran while the app was closed (last 24 hours) caught up when it opens, so that the board is complete.
14. As a user, I want Claude Code to never slow down or fail when the app is closed, so that installing this is safe.
15. As a user, I want the same session never to show as two cards (outside card and history row), so that the board stays clean.
16. As a keyboard and screen reader user, I want Install/Remove as labelled buttons with their state announced, so that I can use them without a mouse.

## Implementation Decisions

- **Hook installer** (server module): reads `~/.claude/settings.json`, adds one entry per event (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd`) whose command posts the hook's JSON from stdin to `http://127.0.0.1:<port>/api/hooks/claude`. It marks each entry so it can find and remove only its own entries. It writes atomically and keeps other keys and formatting stable. The posting command is a small Node script shipped with the app, with a 1 s timeout and always exit 0.
- **Port discovery:** the script reads the port from the app's lock file, so it works in both the desktop app and browser mode. If there is no lock file, it exits 0 straight away.
- **Endpoints:**
  - `GET /api/hooks/claude` returns `{ installed: boolean }`.
  - `POST /api/hooks/claude/install` and `/remove` change the file and broadcast `hooks.updated`.
  - `POST /api/hooks/claude` (the event sink) accepts only loopback requests and a known hook shape. It answers 204 fast and never echoes input.
- **Event → card** mapping per decision 5. The card key is the Claude `session_id`, matched to the existing history ref, so the outside card and the history row are one chat. The chat gets `origin: 'outside'` and `outsideLive: boolean`. Activity comes from the transcript path in the hook payload, tailed the same way history reads Claude JSONL.
- **Catch-up on start:** scan Claude session files changed in the last 24 h. Without a Stop seen, a file idle for over 10 minutes is settled to Review.
- **Continue here** resumes by session id through the existing Claude adapter. It is enabled only when `outsideLive` is false.
- **Notifications** reuse the existing broadcast (`notification`, kind needs-you).

## Testing Decisions

- Test what the user sees or what the API returns.
- **Seam 1, server HTTP API** (prior art: `api.test.ts`, `settings.test.ts`):
  - install/remove on a temp `settings.json` that already has user hooks: ours are added once, user hooks are untouched, and removing restores the file;
  - POSTed events move a card Running → Needs you → Review and broadcast;
  - non-loopback or malformed posts are rejected;
  - catch-up settles idle files;
  - one session never makes two chats.
- **Seam 2, rendered web app** (prior art: `shell.test.tsx`): Settings shows the installed state and the buttons. A seeded outside chat shows the "outside" mark, the read-only composer note, and Continue here once stopped.
- The hook script is tested by running it with no server: it exits 0 within the timeout.

## Out of Scope

- Codex and Antigravity outside sessions live (they have no hooks; history refresh covers them).
- Replying into a chat that is still running in the terminal.
- An MCP server for outside agents (T3 Code's approach).

## Further Notes

- Copy in Settings and the panel follows DESIGN.md voice: no "hook", "session" or "JSON" in user-facing words. Say "Show Claude Code chats you run outside the app".
- Add an "Outside the app" note to DESIGN.md's card conventions: a small muted label, no new colour.

## Progress

- [x] Slice 1: hook installer + `GET/POST install/remove` endpoints, with tests on a temp settings file
- [x] Slice 2: event sink endpoint + hook script; events drive Running/Needs you/Review on one chat keyed by session id
- [x] Slice 3: catch-up on start (24 h, idle settle) and history de-duplication
- [ ] Slice 4: web: Settings section, outside mark on cards, read-only composer note, Continue here
- [ ] Slice 5: DESIGN.md note, glossary check, close #37

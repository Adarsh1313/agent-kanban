# Backlog (order of work)

Updated 2026-10-30. GitHub issues carry the details; this file is the order. A fresh session resumes from here.

## 1. Desktop app (Plan 4): issue #20, now

Built on branch `feat/desktop-app` (2026-10-30), slices 1–8 and 10 of `docs/specs/desktop-app.md`. **Left:** run the manual checklist in the spec (Testing Decisions) on the installed app, then tick slice 9, close #20 and narrow #15 to "Open in app".

Decisions: the spec, `docs/adr/0001-electron-desktop-shell.md` (with the feasibility result), `design/DESIGN.md` (Desktop app), terms in `GLOSSARY.md`. Run it: README "Run it".

**Later, before friends get it:** #26 provider installers without npm, then #25 Mac build, then make the repo public after a history scan. #18 closed (not planned).

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

- Branch `feat/desktop-app`: built on `fix/p1-issues`, adds the desktop app (#20) and Open folder (#15, first half).

Close those issues when they're merged.

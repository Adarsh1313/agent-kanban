# Backlog (order of work)

Updated 2026-10-31. GitHub issues carry the details; this file is the order. A fresh session resumes from here.

## 1. Desktop app (Plan 4): #20, merged, manual check left

Merged into `main` in #35 (2026-10-31): slices 1–8 and 10 of `docs/specs/desktop-app.md`. #20 stays open until the manual checklist in the spec (Testing Decisions) is run on the installed app; then tick slice 9, close #20 and narrow #15 to "Open in app".

Decisions: the spec, `docs/adr/0001-electron-desktop-shell.md` (with the feasibility result), `design/DESIGN.md` (Desktop app), terms in `GLOSSARY.md`. Run it: README "Run it".

**Later, before friends get it:** #26 provider installers without npm, then #25 Mac build, then #33 make the repo public after a history scan, then #34 version check / auto-update. #18 closed (not planned).

## 3. From the Enjoy competitor review (2026-10-30)

Research: `docs/research/2026-10-23-enjoy-competitor-analysis.md`. Features go through `/grill-with-docs` → `/to-spec` → `/implement` in a new session. Order:

1. #27 (P2): auto-resume a chat when its limit resets, sending messages queued while it waited.
2. #28 (P2): hand a chat to another provider with its context (the deferred handoff idea).
3. #32 (P3): positioning copy, "one board for all your agent chats". Small, do directly.
4. #29 (P3): effort level per chat.
5. #30 (P3): several accounts per provider. Lifts an MVP out-of-scope item.
6. #31 (P3): Codex free usage resets. Research T3 Code first.

Left out: routines, project docs, live preview, cloud/remote, more providers, plan advice. Pricing: not now, revisit when the repo goes public.

## 1b. Projects and chats redesign: #11, merged

Merged into `main` in #35 (2026-10-31): `docs/specs/projects-chats-redesign.md`, all slices done, #11 closed. Prototype on branch `prototype/projects-chats-redesign`.
**Follow-ups:** one-off folders from provider history (e.g. `i-have-these-three-csv-files`, worktree names like `angry-newton-faf3ab`) still show as projects; hide them by hand, or decide a rule. The hidden-project check is added by hand in each selector; fold it into one base selector.

## 2. Issues by severity (labels P1 → P3)

**Merged in #35 (2026-10-31), issues closed:** #3, #4, #5, #6, #7, #8, #9, #10, #12, #13, #16, #19, #22, #23, #24.

**Waiting on the user:**
- #21: update failure. Need the message the app showed; both updates worked when run directly.

**P3 left (their issues are closed, so they live here):**
  - From #16: paging (only the last 200 messages are shown); Antigravity history isn't readable.
  - From #19: the remaining items.
  - #17: the archive animation belongs to the motion skills; the rest works as is.
  - #14: can't happen until the Antigravity pin moves.
  - #18: closed (not planned) in the desktop grilling.

**Desktop follow-ups (before friends get the app):** #26 install Claude Code / Codex without npm, then #25 Mac build.

## Merged

- #35 (2026-10-31): `fix/chat-layout-and-launcher`, `feat/any-provider-folders`, `fix/p1-issues` and `feat/desktop-app` in one merge. #15 stays open (Open folder done, "Open in app" left).

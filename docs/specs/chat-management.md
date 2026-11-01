# Chat management and the All chats redesign

Built from `docs/specs/chat-management-decisions.md` (grilled 2026-10-31). Terms are in `GLOSSARY.md`. Closes #41 (feedback items 9 and 13).

## Problem Statement

The chat menu's `…` does nothing, so the user can't archive or delete chats. Old chats pile up on the board and in history. All chats feels misleading: it's one long, dense list with no sense of when things happened. There's also no way to clean up many chats at once.

## Solution

- **The chat menu:** Archive (undoable) and Delete. Delete moves the provider's session file to the app's **Trash** for 30 days.
- **All chats:**
  - rows grouped by day (Today, Yesterday, This week, This month, Older);
  - taller, calmer rows with a plain status word;
  - Archived and Trash filters;
  - select several rows and act on all of them from a bottom action bar.

The layout follows ChatGPT's and Claude.ai's history (date groups, one line per chat, actions on hover) and the multi-select of Linear and Gmail (a checkbox on hover, Shift for a range, a floating bar). It's drawn with our existing list rows, chips, menus and toast.

## User Stories

### The chat menu
1. As a user, I want the `…` menu on a card, a panel and an All chats row to offer Archive, Move to project and Delete, so that I can tidy up where I am.
2. As a user, I want Archive to take the chat off the board and sidebar with an Undo toast and no question, so that it's quick and safe.
3. As a user, I want archived chats under an Archived filter in All chats, with Unarchive, so that I can get them back.
4. As a user, I want Delete to ask first ("Delete this chat? It goes to Trash for 30 days, then it's gone for good."), so that I don't lose work by accident.
5. As a user, I want a deleted chat gone from Claude Code or Codex too, so that it doesn't come back as history.
6. As a user, I want Delete disabled on a running chat with "Stop it first", so that nothing breaks mid-way.
7. As a user, I want Delete disabled on Antigravity chats with "Antigravity chats can't be deleted from here yet", so that I know why.
8. As a user, I want a Trash filter listing deleted chats with days left and Restore, so that I can recover a mistake.
9. As a user, I want Restore to put the session file back so the provider sees it again, so that recovery is complete.
10. As a user, I want trash older than 30 days removed automatically, so that it doesn't grow forever.
11. As a user, I want "Empty trash" to ask first, so that I can clear it on purpose.

### Select several
12. As a user, I want a checkbox to show on an All chats row when I hover or focus it, so that I can start selecting.
13. As a user, I want Shift-click to select a range and a "Select all in view" option, so that big clean-ups are fast.
14. As a user, I want a bar at the bottom showing "12 selected" with Archive, Move to project, Delete and Clear, so that I can act on them all.
15. As a user, I want bulk Delete to say how many and skip running or Antigravity chats with a count of skipped ones, so that I know what happened.
16. As a user, I want bulk Archive to have one Undo, so that undoing is one click.
17. As a user, I want Esc to clear the selection, so that leaving is easy.

### All chats layout
18. As a user, I want chats grouped under Today, Yesterday, This week, This month and Older, so that I can find things by when.
19. As a user, I want each row to show provider logo, title, project, a plain status word and time, with more spacing, so that it's calm to scan.
20. As a user, I want board chats and history-only chats to look the same apart from status ("On board" vs "In history"), so that the list isn't misleading.
21. As a user, I want the search, the filter and the "Show 100 more" kept, so that nothing I rely on goes.

### Accessibility
22. As a keyboard user, I want Space to toggle a row's checkbox and the action bar to be reachable with Tab, so that I don't need a mouse.
23. As a screen reader user, I want the group headings as headings, the selection count announced, and the checkboxes labelled with the chat title.
24. As a user who prefers reduced motion, I want the action bar to appear without sliding.

## Implementation Decisions

- **Archive** reuses `POST /api/chats/:id/archive`. Add `/unarchive` and an `archived` filter on the chat list. History rows get archived as an app-side label keyed by `provider:ref`.
- **Delete:** `POST /api/chats/:id/delete`.
  - Claude: moves `~/.claude/projects/<key>/<id>.jsonl` and its sidecar folder.
  - Codex: moves the rollout file and removes its index line.
  - Both go to `<app data>/trash/<id>/`, with a `meta.json` holding the original paths, the time and the title.
  - A running chat answers 409; an Antigravity chat answers 422.
- **Trash API:** `GET /api/trash`, `POST /api/trash/:id/restore`, `DELETE /api/trash`. On start and every 24 h, entries older than 30 days are purged.
- **Bulk:** `POST /api/chats/bulk { ids, action: 'archive'|'unarchive'|'delete'|'move', projectLabel? }` returns `{ done: string[], skipped: { id, reason }[] }`. Move to project uses the label from `cross-provider.md`; if that slice isn't built yet, Move is hidden.
- **Web:**
  - a `groupByDay` selector;
  - a selection model (a set of ids, plus an anchor for Shift ranges);
  - an action bar component (floating, `--shadow` for floating things, radius 12);
  - Archived and Trash filter options.
  - Row height and spacing use existing tokens; any new value goes into `tokens.css` first.

## Testing Decisions

- **Seam 1, server HTTP API** (prior art: `api.test.ts`, `history.test.ts`) on temp Claude and Codex homes:
  - delete moves the files and hides the chat from history;
  - restore puts them back;
  - running → 409 and Antigravity → 422;
  - the purge removes old entries;
  - bulk reports done and skipped;
  - unarchive works.
- **Seam 2, rendered web app** (prior art: `all-chats.test.tsx`):
  - day groups appear in order;
  - the menu items are disabled with their reasons;
  - Archive shows Undo;
  - Delete confirms;
  - the Trash filter shows days left and Restore;
  - checkbox, Shift range and the bar's counts, bulk results and Esc all work;
  - the 1,000-row render budget still holds.

## Out of Scope

- Hiding a single chat (decision 2).
- Deleting Antigravity chats.
- Exporting chats.

## Further Notes

- The DESIGN.md "All chats" entry is rewritten for day groups, the selection bar and Trash.
- #38 changes the sidebar and the search palette. Build this after #38 merges to avoid conflicts in All chats.

## Progress

- [x] Slice 1: archive/unarchive (incl. history rows) + Archived filter + menu wiring with Undo
- [ ] Slice 2: delete to trash for Claude and Codex, restore, purge, empty trash (API + tests)
- [ ] Slice 3: web: Delete confirm, disabled reasons, Trash filter with Restore
- [ ] Slice 4: All chats layout: day groups, calmer rows, status words
- [ ] Slice 5: select several: checkboxes, Shift range, action bar, bulk API
- [ ] Slice 6: DESIGN.md, glossary check, close #41

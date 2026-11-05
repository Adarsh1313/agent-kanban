# Compare: several project boards on one screen

Built from `docs/specs/several-boards-decisions.md` (grilled 2026-10-31). Terms are in `GLOSSARY.md`. Closes #44 (feedback item 10).

## Problem Statement

The user runs 2–3 projects at once. The board mixes all their chats together, and filtering to one project hides the others. They can't watch several projects side by side.

## Solution

A **Compare** button in the board's top bar lets the user pick up to 3 projects. The board becomes side-by-side panes. Each pane is a compact board for one project, with a header (project, counts, collapse). A collapsed pane shrinks to a narrow strip that still shows its counts. The layout is remembered on this device.

It follows the split views of Linear and Trello's multi-board views, and is built from our existing columns, cards and headers.

**Changed 2026-11-06 (user feedback):** panes stack one below another instead of side by side. Compare takes any number of projects; it starts with the first open and the rest minimized to their header, and at most 3 are open at once (opening a fourth minimizes the one opened longest ago). This replaces the 3-project cap, side-by-side layout and collapsed vertical strip below. Storage is `{ on, projects, open }`.

## User Stories

1. As a user, I want a Compare button on the board, so that I can watch several projects at once.
2. As a user, I want to pick up to 3 projects from My projects first, then the rest, so that it's quick.
3. As a user, I want one pane per project side by side, each with its columns, so that I see every project's state.
4. As a user, I want each pane's header to show the project glyph, name and counts (running, needs you), so that I can read it at a glance.
5. As a user, I want to collapse a pane to a narrow strip with its counts, so that I can focus on the others.
6. As a user, I want to swap or remove a project from a pane's menu, so that I can change what I watch.
7. As a user, I want cards in a pane to work as usual (open the panel, drag between columns), so that nothing new to learn.
8. As a user, I want dragging a card into another pane not allowed, so that chats never change project by accident.
9. As a user, I want cards compact in panes (title, provider, status), so that columns fit.
10. As a user, I want New chat in a pane header to start a chat in that project, so that it's fast.
11. As a user, I want "Exit compare" to go back to the normal board, so that leaving is easy.
12. As a user, I want my Compare panes and collapsed states remembered on this device, so that it opens how I left it.
13. As a user, I want provider focus and filters to apply to every pane, so that it matches the board.
14. As a user, I want a hidden or folder-missing project dropped or dimmed in Compare like everywhere else.
15. As a user on a narrow window, I want panes to scroll horizontally rather than squash, so that cards stay readable.
16. As a keyboard and screen reader user, I want each pane as a labelled region and the collapse as a button with `aria-expanded`.
17. As a user who prefers reduced motion, I want collapse and expand without movement.

## Implementation Decisions

- **Web only. No server change.** Compare state goes in browser storage, wrapped so it's safe when storage is unavailable: `{ projects: string[] (folder keys, max 3), collapsed: string[] }`.
- **Board refactor:** the board's column rendering becomes a component that takes a chat list and a `compact` flag. Compare renders one per project, using the existing project grouping (`folderKey(projectFolder(...))`).
- **Picker:** reuses the My projects picker dialog in single-select-up-to-3 mode, if #38 has merged; otherwise the New chat project list.
- **Layout:** CSS grid, one column per open pane, with collapsed panes at a fixed strip width (a new `--pane-strip-width` token in `tokens.css`). There's a minimum pane width and horizontal scroll below it.
- **Drag:** a drop target outside the source pane snaps back, reusing the existing snap-back toast copy ("Chats stay in their project").

## Testing Decisions

- **Seam 2, rendered web app** (prior art: board tests, `shell.test.tsx`), with a seeded store of 3 projects:
  - Compare opens the picker and caps it at 3;
  - each pane shows only its project's chats in the right columns, with header counts;
  - collapse shows a strip with counts and persists after reload;
  - a drop into another pane snaps back;
  - filters apply to all panes;
  - Exit compare restores the board;
  - a hidden project is dropped.
- A render budget test with 3 panes × 300 chats.

## Out of Scope

- More than 3 panes open at once.
- Moving chats between projects by drag.
- Compare on the Projects page.

## Further Notes

- Builds best after #38 (the picker and project cards).
- DESIGN.md gains the Compare panes and strips.

## Progress

- [x] Slice 1: board columns as a reusable compact component (no visible change) with tests passing
- [x] Slice 2: Compare mode: button, picker (max 3), panes with headers and counts, Exit compare, persisted
- [x] Slice 3: collapse to strip, per-pane menu (swap, remove, New chat), drag snap-back across panes
- [x] Slice 4: filters/focus across panes, narrow-window scroll, render budget; DESIGN.md; close #44

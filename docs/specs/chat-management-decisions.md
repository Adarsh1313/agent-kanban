# Chat management and All chats redesign: decisions (#41)

Grilled 2026-10-31 in one batched session (all recommendations accepted). Earlier decisions: `docs/research/2026-10-31-feedback-and-feasibility.md`. Terms: `GLOSSARY.md`.

1. **Archive:** off the board and sidebar, still in All chats under an Archived filter; Undo toast; uses today's `archived`.
2. **No chat-level Hide.** Archive covers it; Hide project stays project-level. (Refines the issue.)
3. **Delete** moves the provider's session file to `<app data>/trash/` for 30 days (round 1, decision 3). All chats gets a Trash filter with Restore. Disabled for Antigravity chats, with the reason.
4. **A running chat can't be deleted**; the item is disabled with "Stop it first".
5. **Select several in All chats only:** a checkbox on row hover/focus, Shift-click for a range, a bottom action bar with Archive · Delete · Move to project.
6. **Redesign:** rows grouped by day (Today, Yesterday, This week, Older), taller calmer rows, a clearer status label. Prototype first.

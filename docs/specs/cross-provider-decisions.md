# Skills, workflow and context across providers: decisions (#40, includes #28)

Grilled 2026-10-31 in one batched session (all recommendations accepted). Earlier decisions: `docs/research/2026-10-31-feedback-and-feasibility.md`. Terms: `GLOSSARY.md`.

1. **Sync runs** on app start and when the home provider's skill folders change (file watcher); Settings has Sync now.
2. **Marking:** a `.agent-kanban-managed` file in each copied skill folder; in `AGENTS.md` / `GEMINI.md` a fenced `<!-- managed by Agent Kanban -->…<!-- end -->` block, so the user's own text survives.
3. **Conflict:** a same-named unmanaged skill in the target is left alone; ours is skipped and listed as "Not synced: you already have X in Codex".
4. **Removed from home** → its managed copies are removed.
5. **One toggle** for the whole sync in v1; no per-skill choice.
6. **Handoff UI:** the composer's provider picker stays enabled mid-chat. Switching shows "Codex will get the last messages, your spec's progress and project notes." It takes effect on send. One card; each reply carries its provider.
7. **Project notes** live at `<project>/.agent-kanban/notes.md`. Instruction files get one managed line to read and update it at the end of each task. Off by default; turned on per project, since it writes into the user's folder.
8. **Active spec** = the newest `docs/specs/*.md` with unchecked Progress items; omitted if none.
9. **Move to project (item 4) is a label only.** The chat shows under the new project; resuming still runs in the original folder, and the panel says so.

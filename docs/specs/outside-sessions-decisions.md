# Outside sessions on the board: decisions (#37)

Grilled 2026-10-31 in one batched session (all recommendations accepted). Earlier decisions: `docs/research/2026-10-31-feedback-and-feasibility.md`. Terms: `GLOSSARY.md`.

1. **Every outside Claude Code session gets a card**, even outside My projects; the existing "New activity in X · Add" hint still shows.
2. **Watch only while it runs outside:** status, activity line, transcript. Once it stops, **Continue here** resumes it in the app.
3. **App closed:** the hook fails silently with a 1 s timeout, never slowing Claude Code. On start the app catches up from session files written in the last 24 h.
4. **v1 is Claude hooks only.** Codex and Antigravity outside runs appear when history refreshes, as today.
5. **Mapping:** SessionStart / UserPromptSubmit → Running; Notification → Needs you ("Wants permission" or "Waiting for you"); Stop → Review; SessionEnd keeps Review.
6. Install and remove in one click from Settings (round 2, decision 6). Only our own entry in `~/.claude/settings.json` is touched.

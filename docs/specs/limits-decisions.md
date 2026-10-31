# Limits, auto-resume, follow-up queue and accounts: decisions (#39, includes #27, #30, #31)

Grilled 2026-10-31 in one batched session (all recommendations accepted). Earlier decisions: `docs/research/2026-10-31-feedback-and-feasibility.md`. Terms: `GLOSSARY.md`.

1. **Auto-resume is on by default, per chat.** The card reads "Out of usage · resumes 2:40 pm" with a "Don't resume" toggle.
2. **At reset** it sends the queued follow-ups, or "Continue where you left off." if none.
3. **Follow-up queue:** messages sent while a chat works or waits become chips above the composer: edit, delete, Send now (Send now interrupts). Our own chats only.
4. **Out of usage is a needs-you reason** (amber), not a column.
5. **Accounts:** Connections → provider → "Add another account" signs in to a separate config folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Antigravity: one account in v1.
6. **One active account per provider, global.** Switching affects new chats and resumes, never running ones. When a chat runs out and another account has room: "Switch to Work account and continue". Never automatic (round 3).
7. **Codex free resets (#31):** show the banked count and Use reset only if Codex exposes them locally; a research gate opens that slice, otherwise it is dropped from v1.
8. **Later, own research notes:** plan advice, Antigravity limits (feedback item 14).

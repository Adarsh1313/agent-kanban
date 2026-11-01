# Composer: effort and suggested next steps: decisions (#42, includes #29)

Grilled 2026-10-31 in one batched session (all recommendations accepted). Earlier decisions: `docs/research/2026-10-31-feedback-and-feasibility.md`. Terms: `GLOSSARY.md`.

1. **Effort:** Quick · Normal · Thorough, mapped per provider (Claude effort low/medium/high; Codex `model_reasoning_effort`; hidden where unsupported). Sticky per chat; default Normal.
2. **Suggested next steps come from the agent itself:** a short added instruction asks for up to 3 `Next:` lines at the end of a reply; we parse and strip them. No extra model call.
3. **Clicking a suggestion fills the composer**; it does not send.
4. **Presets are later**, out of scope.

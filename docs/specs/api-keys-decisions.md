# Your own API keys and spend cap: decisions (#43)

Grilled 2026-10-31 in one batched session (all recommendations accepted). Earlier decisions: `docs/research/2026-10-31-feedback-and-feasibility.md`. Terms: `GLOSSARY.md`. Security rules from round 2, decision 5 stand unchanged.

1. **Managed in Connections → provider → API keys:** several per provider, each named, last 4 characters shown.
2. **Chosen per chat, never automatic.** The out-of-usage nudge offers "Continue with API key 'Personal' (billed per use)"; a confirm shows the cap.
3. **Spend cap:** we sum each turn's reported cost (Claude `total_cost_usd`; Codex tokens × a price table). At the cap the chat stops with "Spend cap reached". Resets monthly.
4. **No validation call on save**; a bad key fails on first use with a plain message.

# Your own API keys with a spend cap

Built from `docs/specs/api-keys-decisions.md` (grilled 2026-10-31). Terms are in `GLOSSARY.md`. Closes #43 (feedback item 12).

## Problem Statement

When a plan runs out, the user either waits or pays by hand somewhere else. They have API keys, but using them means setting environment variables. It's also easy to spend more than they meant to, because API use is billed per use.

## Solution

- **Adding keys:** in Connections, a provider can hold several named **API keys**. A key is stored encrypted with the operating system's key store. After saving, it's never shown again; only its last 4 characters are.
- **Using a key:** only when the user chooses it for a chat, usually from the out-of-usage nudge ("Continue with API key 'Personal' · billed per use").
- **Spend cap:** each key has an optional monthly cap. The chat stops when the cap is reached.

This follows how password managers and the providers' own consoles treat keys: write-only, masked, named. It's built from our existing Connections rows, dialog and needs-you reasons.

## User Stories

1. As a user, I want an "API keys" section on a provider's Connections card, so that keys live next to my sign-in.
2. As a user, I want to add a key with a name, paste it once and save it, so that it's simple.
3. As a user, I want only "••••1a2b" shown after saving, with no way to reveal or copy it, so that no one can read it from the app.
4. As a user, I want to rename or delete a key, with a question first on delete, so that I can manage them.
5. As a user, I want a note that says keys are stored encrypted on this computer and billed per use by the provider, so that I understand the cost.
6. As a user, I want an optional monthly spend cap per key in dollars, so that I can't overspend.
7. As a user, I want each key to show "$3.20 of $10 this month", so that I see where I am.
8. As a user, I want the out-of-usage nudge to offer "Continue with API key 'Personal'", so that I can carry on when my plan runs out.
9. As a user, I want a confirm that shows the cap and says it's billed per use, so that I choose knowingly.
10. As a user, I want the chat marked "Using API key 'Personal'" while it runs on a key, so that I always know.
11. As a user, I want the chat to stop with "Spend cap reached" (a needs-you reason) at the cap, so that I'm never surprised by a bill.
12. As a user, I want a bad key to fail with "This API key didn't work. Check it in Connections.", so that I know what to fix.
13. As a user, I want the API keys section hidden in browser mode, with a line saying keys work in the desktop app only, so that keys are never handled by a browser.
14. As a user, I want keys never exported or synced, so that they stay on this computer.
15. As a keyboard and screen reader user, I want the key field as a password field, and the cap and usage announced.

## Implementation Decisions

- **Storage** (desktop main process only):
  - Keys are encrypted with Electron `safeStorage` and saved to `<app data>/keys.json` as `{ id, provider, name, last4, cipher, capUsd|null, spentUsd, month }`.
  - The server holds only the metadata. It asks the main process for the plaintext over the existing desktop IPC bridge, and only at spawn.
  - Browser mode has no bridge, so every key endpoint answers 404 there and the UI hides the section.
- **API:**
  - `GET /api/keys` returns metadata only.
  - `POST /api/keys { provider, name, key }`: the key travels once, to the local server, which hands it to the main process and drops it.
  - `PATCH /api/keys/:id { name?, capUsd? }`.
  - `DELETE /api/keys/:id`.
  - Request bodies for these routes are never logged; add a redaction test.
- **Use:**
  - `POST /api/chats/:id/use-key { keyId }` resumes the chat with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` set in the spawned provider's environment only.
  - The chat stores `keyId`.
  - The key value never goes into chat state, broadcasts or errors.
- **Spend:**
  - Each turn's cost is added to the key: Claude's result `total_cost_usd`; Codex tokens × a small price table in code.
  - The month rolls over automatically.
  - At or over the cap, the server stops the chat and sets `needsReason: 'spend-cap'`.
- **Nudge:** extends the out-of-usage nudge from `limits.md` when that provider has a key.

## Testing Decisions

- **Seam 1, server HTTP API** (prior art: `desktop-mode.test.ts`, `chats.test.ts`), with a fake key store standing in for the bridge:
  - POST returns metadata with last4 and never the key;
  - GET never contains the key;
  - key routes answer 404 in browser mode;
  - use-key passes the env var to a fake adapter spawn and nowhere else (assert broadcasts and logs don't contain it);
  - spend adds up, the cap stops the chat with the reason, and the month rolls over.
- **Seam 2, rendered web app:**
  - the section is hidden in browser mode;
  - adding a key shows the masked value;
  - the cap and spend line render;
  - the nudge offers the key, with a confirm showing the cap;
  - a running chat shows "Using API key".
- The main-process encryption is covered by a desktop test that checks the stored file doesn't contain the plaintext.

## Out of Scope

- Using keys automatically.
- Checking a key on save (no network call with the key).
- OpenRouter or other gateways.
- Syncing or exporting keys.

## Further Notes

- Depends on the out-of-usage nudge in `limits.md` (slice 1) for the main entry point. A key can also be picked from the chat menu as "Continue with API key".
- DESIGN.md gains key rows and the spend line.

## Progress

- [x] Slice 1: desktop key store (safeStorage, IPC bridge) + metadata API, browser-mode 404, redaction tests
- [x] Slice 2: use-key: env passed to the provider spawn only; "Using API key" on the chat
- [x] Slice 3: spend tracking, monthly cap, Spend cap reached reason
- [ ] Slice 4: web: Connections API keys section (add, masked, rename, delete, cap, spend), nudge + confirm
- [ ] Slice 5: DESIGN.md, glossary check, close #43

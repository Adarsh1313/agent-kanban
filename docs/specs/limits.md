# Limits: auto-resume, follow-up queue and accounts

Built from `docs/specs/limits-decisions.md` (grilled 2026-10-31). Terms are in `GLOSSARY.md`. Closes #39 (includes #27, #30, #31).

## Problem Statement

When a provider's plan limit is reached, the chat stops with an error. The user has to remember to come back at the reset time and type "continue". They can't line up their next instruction while an agent works. If they pay for two accounts with the same provider, switching means signing out and back in.

## Solution

A chat that hits its limit shows **Out of usage · resumes 2:40 pm**, a needs-you reason. At the reset it carries on by itself. It sends anything in its **follow-up queue**, or "Continue where you left off." if the queue is empty. Messages written while a chat works or is out of usage join that queue as editable chips.

In Connections, a provider can have several **accounts**. One is active, and switching takes one click. When a chat runs out and another account has room, the card offers to switch and continue. It never switches by itself.

The patterns come from Enjoy ("Out of usage", an editable queue) and T3 Code ("paused until the limit resets", one account per config folder). They're built from our existing card, badge, chip and Connections components.

## User Stories

### Out of usage and auto-resume
1. As a user, I want a chat that hits its limit to show "Out of usage · resumes 2:40 pm" instead of an error, so that I know it will carry on.
2. As a user, I want it in Needs you with the amber badge, bell and tray dot, so that it uses the one signal I already know.
3. As a user, I want it to continue on its own at the reset time, so that I don't have to come back.
4. As a user, I want a "Don't resume" toggle on that chat, so that I can stop it continuing.
5. As a user, I want it to send my queued follow-ups at the reset, or "Continue where you left off." if there are none, so that the agent picks up the right thing.
6. As a user, I want auto-resume to survive the app restarting before the reset, and to run on open if the reset passed while the app was closed, so that it isn't lost.
7. As a user, I want "Out of usage · resets later" with no automatic retry when the reset time is unknown, so that it never loops.

### Follow-up queue
8. As a user, I want to send a message while the agent is working and see it queued above the composer, so that I can line up my next instruction.
9. As a user, I want to edit or remove a queued message, so that I can change my mind.
10. As a user, I want "Send now" on a queued message to interrupt and send it, so that I can redirect the agent.
11. As a user, I want queued messages sent in order when the turn ends (or at the reset), so that it behaves predictably.
12. As a user, I want the card to show "2 queued", so that I can see it on the board.
13. As a user, I want stopping the chat to clear the queue but put the text back in the composer, so that I don't lose it.

### Accounts
14. As a user, I want "Add another account" on a provider's card in Connections, so that I can sign in to a second plan.
15. As a user, I want to give each account a name (e.g. "Personal", "Work") and change it later, so that I can tell them apart.
16. As a user, I want one account marked active and a one-click "Use this account", so that switching is easy.
17. As a user, I want switching to affect new chats and resumes only, never running chats, so that nothing breaks mid-way.
18. As a user, I want the usage meters to show the active account, plus a small list per account, so that I know which has room.
19. As a user, I want an out-of-usage chat to offer "Switch to Work and continue" when another account has room, so that I keep working.
20. As a user, I want the app never to switch accounts on its own, so that I stay within the providers' rules.
21. As a user, I want removing an account to ask first and say its chats stay readable, so that removing is safe.

### Codex free resets
22. As a Codex user, I want banked free resets shown as "2 free resets" with a Use reset button, if Codex exposes them on this computer, so that I can get back to work.

### Accessibility
23. As a screen reader user, I want the Out of usage reason, the resume time and the queue count announced on the card, so that they aren't visual-only.
24. As a keyboard user, I want queue chips, Send now and the account actions reachable with Tab and Enter.

## Implementation Decisions

- **Chat state:** add `needsReason: 'out-of-usage'`, `resumeAt: string | null`, `autoResume: boolean` (default true) and `queue: { id, text }[]`. All of these are persisted in the store with a migration. The existing `limit.reached` event, with `resetsAt` from the usage readings, sets them.
- **Resume scheduler** (server): one timer for the earliest `resumeAt` across all chats, re-armed on any change and on start. When it fires, it sends the queue in order (or the default text) through the chat's normal send path, then clears the reason. Resumes missed while the app was closed run on start.
- **Queue:**
  - `POST /api/chats/:id/messages` appends to the queue, rather than failing, while the chat is running or out of usage.
  - `PATCH`/`DELETE /api/chats/:id/queue/:qid` edits or removes an item.
  - `POST …/queue/:qid/send-now` interrupts through the existing stop path, then sends.
  - At turn end the server sends the next queued item.
  - Every change broadcasts `chat.updated`.
- **Accounts:**
  - A new `accounts` table: `{ id, provider, name, configDir, active }`.
  - Adding an account creates `<app data>/accounts/<provider>/<id>/` and runs the existing connect and sign-in flow with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` pointing at it.
  - The sign-in that already exists becomes the "Default" account, with no env override.
  - The adapter gets the active account's env when it starts a chat or a resume, and the chat stores `accountId`.
  - Endpoints live under `/api/accounts`, and usage is read per account.
- **Switch-and-continue nudge:** shown when the chat is out of usage and another account's usage reading is under its limit. Clicking it makes that account active and resumes now.
- **Codex resets (research gate):** first inspect Codex's local files and app-server for banked-reset data. If it's there, add `GET /api/usage/codex/resets` and `POST …/use`. If not, record that in the research doc and drop slice 6.
- **UI:** existing parts only:
  - the needs-you badge;
  - a chip row above the composer, in the filter chip style;
  - an account list on the Connections card (rows like Projects rows);
  - the top-bar usage meters.

## Testing Decisions

- **Seam 1, server HTTP API** (prior art: `chats.test.ts`, `usage-service.test.ts`, `connect.test.ts`), with a fake adapter and a fake clock:
  - **Out of usage:** `limit.reached` sets the reason and `resumeAt`. At that time the queue is sent in order. With `autoResume: false` nothing is sent. A restart after the time resumes on start. With no `resetsAt` there's no timer.
  - **Queue:** append while running, edit, delete, send-now interrupts, items are sent at turn end.
  - **Accounts:** adding one creates a config folder and passes its env to the adapter. Switching leaves running chats alone. Removing works.
- **Seam 2, rendered web app** (prior art: `shell.test.tsx` and the chat panel tests):
  - A seeded out-of-usage chat shows the reason, the time and the toggle, plus the switch nudge when another account has room.
  - Queue chips can be edited and removed, and Send now works.
  - The Connections account list shows the active account and "Use this account".

## Out of Scope

- Switching accounts automatically.
- Several Antigravity accounts, and Antigravity limits (feedback item 14, which needs its own research).
- Plan advice.
- A separate account per project.

## Further Notes

- DESIGN.md gains the Out of usage copy, queue chips and the account rows in Connections.
- The voice says "Out of usage", never "rate limited".

## Progress

- [x] Slice 1: out-of-usage state + resume scheduler (persisted, restart-safe, Don't resume) with API tests
- [x] Slice 2: follow-up queue API (append, edit, delete, send-now, send at turn end)
- [ ] Slice 3: web: Out of usage card/panel copy, toggle, queue chips, "N queued" on cards
- [ ] Slice 4: accounts: table, config folders, sign-in per account, active account passed to adapters, usage per account
- [ ] Slice 5: web: Connections account list, Use this account, remove; switch-and-continue nudge
- [ ] Slice 6: Codex free resets (research gate; drop if not exposed)
- [ ] Slice 7: DESIGN.md, glossary check, close #39 (and #27, #30, #31)

## Implementation notes

- The needs-you reason stays `limit` internally; the copy says "Out of usage".
- Claude's adapter now reads the SDK's `rate_limit_event` (rejected, `resetsAt`) and the "hit your limit" result text. Before this, only Codex reported limits.
- The queue holds messages only while out of usage. A message sent while the agent is running still goes straight to the provider, which already holds it until the current step ends, so nothing changed there.

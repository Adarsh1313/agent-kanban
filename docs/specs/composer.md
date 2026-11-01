# Composer: effort and suggested next steps

Built from `docs/specs/composer-decisions.md` (grilled 2026-10-31). Terms are in `GLOSSARY.md`. Closes #42 (includes #29).

## Problem Statement

The user can't tell an agent to answer quickly or to take extra time without knowing each provider's setting names. After a reply, a non-technical user often doesn't know what to ask next.

## Solution

- **Effort:** a picker in the composer with three choices: **Quick**, **Normal** and **Thorough**. We map the choice to each provider's own setting.
- **Suggested next steps:** after each reply, up to 3 appear as chips. Clicking one fills the composer, ready to edit or send. The agent writes them as part of its reply, so there is no extra model call.

## User Stories

1. As a user, I want an effort picker beside the model in the composer, so that I can choose how hard the agent thinks.
2. As a user, I want plain choices (Quick, Normal, Thorough), each with a one-line hint, so that I don't need provider jargon.
3. As a user, I want effort remembered per chat, starting at Normal, so that I set it once.
4. As a user, I want the picker hidden for a provider that has no such setting, so that I'm never offered something that does nothing.
5. As a user, I want a change to apply from my next message, so that it's predictable.
6. As a user, I want each reply to note its effort when it wasn't Normal, so that I can see what ran.
7. As a user, I want up to 3 suggested next steps as chips under the latest reply, so that I know what to do next.
8. As a user, I want clicking a suggestion to fill the composer without sending, so that I can edit it first.
9. As a user, I want suggestions gone once I send anything, so that old ones don't linger.
10. As a user, I want the `Next:` lines removed from the reply text, so that the reply reads cleanly.
11. As a user, I want a Settings switch to turn suggestions off, so that I can avoid them.
12. As a keyboard and screen reader user, I want the picker as a labelled menu and the chips as buttons in a group named "Suggested next steps".

## Implementation Decisions

- **Shared type:** `Effort = 'quick' | 'normal' | 'thorough'`.
- **Chat state:** a chat stores `effort` (default `'normal'`); `PATCH /api/chats/:id { effort }` validates it.
- **Mapping:** each adapter reports `capabilities.effort: boolean` and maps the value when it starts a turn.
  - Claude: Agent SDK effort/thinking setting low/medium/high.
  - Codex: app-server `model_reasoning_effort` low/medium/high.
  - Antigravity: false until it's supported.
- **Suggestions:**
  - The system preface asks for up to 3 lines of the form `Next: <short instruction>` at the very end of a reply.
  - The server parses trailing `Next:` lines at turn end, strips them from the stored text and stores `suggestions: string[]` (max 3, each max 120 characters) on the last assistant message.
  - The setting `suggestNextSteps: boolean` (default true) skips both the preface and the parse.
- **Web:**
  - the picker is a menu button in the composer's model row;
  - the chips are secondary buttons under the last reply;
  - clicking one sets the composer text and focuses it.

## Testing Decisions

- **Seam 1, server HTTP API** (prior art: `chats.test.ts`, `claude-adapter.test.ts`, `codex-adapter.test.ts`):
  - PATCH validates effort;
  - a fake adapter receives the mapped value;
  - a reply ending in `Next:` lines is stored stripped, with `suggestions`;
  - with the setting off, nothing is parsed;
  - more than 3 lines are trimmed to 3.
- **Seam 2, rendered web app:**
  - the picker shows the three choices and is hidden for a provider without the capability;
  - chips render under the last reply;
  - a click fills the composer and doesn't send;
  - the chips disappear after sending.

## Out of Scope

- Presets (agent, model and effort saved under a name).
- Suggesting an effort from the prompt.
- A "go high on this" phrase trigger.

## Further Notes

- DESIGN.md gains the effort picker and the suggestion chips. The copy says "Quick, Normal, Thorough", never "reasoning".

## Progress

- [x] Slice 1: effort on chats (type, PATCH, adapters map it, capability flag) with tests
- [x] Slice 2: web: effort picker, per-reply effort note
- [x] Slice 3: suggested next steps: preface, parse and strip, setting, with tests
- [x] Slice 4: web: suggestion chips, fill composer, Settings switch; DESIGN.md; close #42 and #29

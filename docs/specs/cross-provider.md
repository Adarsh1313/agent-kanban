# Skills, workflow and context across providers

Built from `docs/specs/cross-provider-decisions.md` (grilled 2026-10-31). Terms are in `GLOSSARY.md`. Closes #40 (includes #28; feedback items 3 and 4).

## Problem Statement

Claude's limit was hit mid-way through a project, so the user moved the work to Codex by hand. Codex had none of their skills, global instructions or workflow. It implemented directly and patched things. Back in Claude, a review found a lot of missed work. Each provider starts as a stranger: it doesn't know how the user works or what the other providers already decided.

## Solution

- **Home provider:** in onboarding the user picks a home provider.
- **Skill sync:** copies the home provider's skills (plugin skills included) and global instructions one way into the other providers. Each copy is marked as managed.
- **Skills in the composer:** `/` lists the same skills for every provider.
- **Handoff:** a chat can switch provider mid-way. The new provider gets three things:
  - the last real messages (about 16k tokens);
  - a pointer to the active spec's Progress checklist;
  - the project's **project notes**, which every agent updates at the end of a task.
- **Move to project:** a chat can be moved to another project, as a label.

## User Stories

### Home provider and skill sync
1. As a new user, I want onboarding to ask which provider I use most (my home provider), so that my setup can follow me to the others.
2. As a user, I want my home provider's skills, plugin skills and global instructions copied to the other providers, so that they work the way I do.
3. As a user, I want onboarding and Settings to list the synced skill names behind "Show more", so that I know what was copied.
4. As a user, I want skills I made directly in Codex or Antigravity left alone, so that sync never destroys my work.
5. As a user, I want a skill whose name is already taken in another provider to be skipped and listed as "Not synced: you already have X in Codex", so that I understand the gap.
6. As a user, I want copies updated when I edit a skill in my home provider, and removed when I delete it, so that the providers stay in step.
7. As a user, I want my own text in AGENTS.md and GEMINI.md kept, with only the managed block replaced, so that sync doesn't overwrite me.
8. As a user, I want one Skill sync toggle and a Sync now button in Settings, so that I'm in control.
9. As a user, I want to change my home provider in Settings, so that I can change my mind.

### Invoking skills
10. As a user, I want `/` in the composer to list the same skills for every provider, so that I don't need to learn each tool.
11. As a user, I want picking a skill to send it in that provider's own form, so that it actually runs.

### Handoff
12. As a user, I want to pick another provider in the composer of an existing chat, so that I can carry on when one runs out.
13. As a user, I want a note before sending that says what the new provider gets, so that I trust the handoff.
14. As a user, I want the switch to happen when I send, so that picking a provider alone does nothing.
15. As a user, I want each reply to show which provider wrote it, so that I can follow who did what.
16. As a user, I want a provider I switch back to to continue from where it was, getting only what happened since, so that nothing is repeated.
17. As a user, I want the out-of-usage nudge to offer "Continue with Codex", so that a handoff is one click when a limit hits.

### Project notes
18. As a user, I want to turn on project notes per project, with a line saying this adds a file to my folder, so that nothing is written into my project without my say-so.
19. As a user, I want every provider told to read and update the notes at the end of each task, so that decisions travel.
20. As a user, I want to open and edit the notes from the project page, so that I can correct them.

### Move to project
21. As a user, I want "Move to project" in the chat menu, so that a chat shows where it belongs.
22. As a user, I want the panel to say the chat still runs in its original folder, so that I'm not surprised.

### Accessibility
23. As a keyboard and screen reader user, I want the `/` list to be a listbox, and the provider picker and handoff note announced.

## Implementation Decisions

- **Settings:** `homeProvider: ProviderId | null`; `skillSync: boolean`, true by default once a home provider is picked; `notesProjects: string[]` of folder keys.
- **Sync engine** (server module `skills/`):
  - **Sources:** `~/.claude/skills/*`, the skill folders in the plugin cache, and the home provider's global instructions (`~/.claude/CLAUDE.md` for Claude).
  - **Targets:** `~/.codex/skills`, `~/.gemini/antigravity/skills`, `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`, leaving out the home provider's own.
  - **Copies:** each skill folder gets a `.agent-kanban-managed` marker holding its source path and a content hash. When the hash changes, the copy is updated; when the source is gone, the copy is removed.
  - **Name clashes:** an unmanaged folder with the same name is skipped and reported.
  - **Instruction files:** only the fenced managed block is replaced.
  - **When it runs:** on start, on a debounced watch of the source folders, and on `POST /api/skills/sync`.
  - **API:** `GET /api/skills` returns `{ synced: string[], skipped: { name, provider }[] }`.
- **Composer `/`:** the skill list comes from `GET /api/skills`. On send, the adapter turns the skill into that provider's form: `/name` for Claude, `$name` for Codex, a workflow call for Antigravity.
- **Handoff:**
  - **What a chat stores:** the provider of each message, and for each provider its own session ref (`providerRefs: Record<ProviderId, string>`) and the last message index it saw.
  - **Building the handoff text** when the provider changes at send:
    - real messages, newest first, up to 16k tokens (estimated at 4 characters per token; items that aren't messages are capped at 240 characters);
    - only what happened since, if that provider has taken part before;
    - the active spec's path with its unchecked Progress lines (decision 8);
    - the notes file's content, if notes are on.
  - **Sending:** the text goes as a preface on the first message to the new provider.
  - The existing adapters are reused. In v1, Codex gets the history as text.
- **Project notes:**
  - Turning them on creates `<project>/.agent-kanban/notes.md`. It also adds a managed line to the project's `CLAUDE.md`, `AGENTS.md` and `GEMINI.md`, in fenced blocks, creating the files if they're missing.
  - Turning them off removes the managed lines and keeps the notes file.
- **Move to project:** `PATCH /api/chats/:id { projectLabel }`. Selectors group chats by `projectLabel ?? cwd`, and resuming still uses `cwd`.
- **UI:**
  - a home provider step in onboarding, with provider tiles that reuse the Connections cards;
  - a section in Settings;
  - the composer's provider picker, enabled mid-chat;
  - a provider logo on each reply;
  - a notes toggle and Open notes on the project page.

## Testing Decisions

- **Seam 1, server HTTP API** (prior art: `settings.test.ts`, `history.test.ts`, `chats.test.ts`), on temp home folders:
  - **Sync:** copies and marks skills, updates them on change, removes them on delete, skips name clashes and keeps the user's text in instruction files.
  - **Skills API:** `GET /api/skills` reports the synced and skipped skills.
  - **Handoff:** a fake adapter receives a preface within the budget, with the spec pointer and the notes. On a second switch it gets only what happened since.
  - **Notes:** turning them on and off writes and removes the managed lines.
  - **Move to project:** changes the grouping, not `cwd`.
- **Seam 2, rendered web app:**
  - the onboarding home provider step writes the setting;
  - Settings lists the skills behind Show more;
  - `/` lists the skills;
  - switching provider shows the note;
  - replies show provider logos;
  - Move to project moves the chat in the sidebar and in lists.

## Out of Scope

- A skills library or marketplace.
- Choosing which skills to sync; two-way sync.
- Actually moving a session file to another folder.
- An AI-written summary for the handoff.

## Further Notes

- The token budget can be tuned later, so keep it as one constant.
- DESIGN.md gains the handoff note, the provider mark on replies and the home provider step.

## Progress

- [x] Slice 1: settings (`homeProvider`, `skillSync`) + sync engine for skills folders with tests
- [x] Slice 2: instruction files managed block + plugin skills + file watch + `GET/POST /api/skills`
- [x] Slice 3: web: onboarding home provider step, Settings section (Show more, skipped list, Sync now)
- [x] Slice 4: composer `/` skill list with per-provider form on send
- [x] Slice 5: handoff engine (per-provider refs, budgeted preface, delta, spec pointer) with tests
- [ ] Slice 6: web: provider picker mid-chat, handoff note, provider per reply, "Continue with Codex" nudge
- [ ] Slice 7: project notes toggle and managed lines; notes in handoff; Open notes on project page
- [ ] Slice 8: Move to project label; DESIGN.md, glossary check, close #40 and #28

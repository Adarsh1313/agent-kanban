# Feedback after using the app, and what's feasible

Date: 2026-10-31. Source: the user's brain dump after using the installed desktop app. Status: **being grilled**; GitHub issues come after the grill.

**Why we exist** (README problem statement): people pay for Claude, ChatGPT and Gemini but use a fraction of them. T3 Code serves developers. We give non-technical knowledge workers one simple place to get the most out of every subscription, with no terminal.

## Feedback items

| # | Ask | Feasible? | How, in short | Size |
|---|---|---|---|---|
| 1 | Onboarding: pick the projects I work on (of ~60); only those feed Recent chats and Projects | Yes | A "my projects" setting (the opposite of `hiddenProjects`). Onboarding lists projects by last activity with the recent ones pre-ticked | M |
| 2 | Speaker icon in onboarding to preview the chime; chime 200% louder | Yes | Play the chime through a Web Audio gain of 2 (watch for clipping) | S |
| 3 | Cross-provider chats in one project, sharing context, even when I use Claude Code directly | Yes, with limits | A shared project memory file that every provider already reads: `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` point at one notes file. Our app appends a summary when a chat finishes. Code changes are already shared through the folder and git; the notes file carries the *decisions* | L |
| 4 | Move an existing chat into another project / folder | Partly | Easy: reassign it in our app (a label). Hard: really resuming it in another folder, since Claude stores sessions per folder. That means copying the session file, which is fragile | S (label) / L (real move) |
| 5 | Recent chats vs recent projects with their top 3–4 chats | Design question | Grill | – |
| 6 | Codex chat shows "Earlier messages are in Codex" | **Bug, root cause found** | Codex now writes active chats as plain `rollout-*.jsonl`; we only read `.jsonl.zst` (`apps/server/src/history/codex.ts` `indexRollouts`, and `transcript.ts` `readCodex` always decompresses). Read both | S |
| 7 | Sidebar: drop the extra "New chat"; one global search for chats and projects | Yes | Command-palette style search (`Ctrl+K`): chats, projects, and a project's chats | M |
| 8 | Chat panel should open scrolled to the bottom; the `…` menu does nothing | Yes (bugs) | Scroll to the end on open; give the menu real items (see 9) | S |
| 9 | Chat menu: Delete, Archive, Hide | Yes | Archive and Hide are ours (`archived` exists). Delete removes the provider's session file: Claude `~/.claude/projects/…/<id>.jsonl`, Codex rollout + index line. Antigravity is unknown. Irreversible, so it needs a recovery story | M |
| 10 | Up to 3 project boards on one screen, each collapsible | Yes | A split view of per-project boards | M |
| 11 | Show Claude Code sessions I run outside the app, live on the board (Running → Review) | Yes | Claude Code **hooks** (`SessionStart`, `Stop`, `Notification`) post to our local server. Install them with one click from Settings. Fallback: watch session files for recent writes | M |
| 12 | Bring your own API keys, several per provider, encrypted | Yes | Electron `safeStorage` (Windows DPAPI). Pass as `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` when a plan runs out. Note: API use is billed per token, so it needs a cost warning | M |
| 13 | All chats page feels misleading; redesign it | Yes | Design pass; look at how other apps lay out chat history | M |
| 14 | Antigravity limits via a community extension | Research | Unknown until we inspect such an extension's data source | ? |

## From the Enjoy research (must add)

| Feature | Feasible? | How |
|---|---|---|
| Several accounts per provider, switch in one click | Yes | Separate config folders per account (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) |
| Resume on its own when a limit resets | Yes, small | We already know `resetsAt` on "limit reached"; queue the next message and send it then |
| Switch agent mid-chat with context | Yes | Summarise the chat and start the other provider with it. Shares machinery with item 3 |
| Effort level ("quick" / "take extra time") | Yes | Not estimated: the user picks, and we map it to each provider's setting (Claude effort or thinking, Codex `model_reasoning_effort`). Optional later: suggest one from the prompt |
| Scheduled routines (weekdays 8 am) | Yes, while the app runs | A scheduler in the server. When the app is closed, a Windows Task Scheduler entry could start it |

## Research still to do

- **enjoy.dev**, section by section in Chrome: needs the user to open it.
- **T3 Code**: what to borrow for providers, cross-provider context and simplicity.
- **Item 14**: Antigravity quota sources.

T3 Code findings: `docs/research/2026-10-31-t3code-analysis.md`.

## Decisions (grill round 1, 2026-10-31)

1. **First user: the user themself**, running 2–3 Claude Code sessions across projects. Everything on the list is wanted; the order below holds.
2. **Sidebar:** "My projects" (picked in onboarding), each with its 3 newest chats, plus one global search box that replaces the sidebar's New chat. All chats stays for the rest.
3. **Delete:** moves the provider's session file to Agent Kanban's own trash for 30 days, then deletes it.
4. **Context across providers:** a shared, editable notes file per project is fine. But the real problem is bigger. **Skills and workflow must travel too.**
   - What happened: Claude's limit was hit mid-way through LocalFlow, so the work moved to Codex by hand.
   - Codex had none of the user's skills or workflow, so it implemented directly and patched things.
   - Back in Claude Code after the reset, a code review found a lot of missed work.
   - Ask: import the skills and workflow from the provider the user uses most, and keep them in sync across Claude Code, Codex and Antigravity.
   - Feasible: all three read the same `SKILL.md` folder format:
     - `~/.claude/skills`
     - `~/.codex/skills`
     - `~/.gemini/antigravity/skills`
   - Global instructions map across too: `~/.claude/CLAUDE.md` → `~/.codex/AGENTS.md` → `~/.gemini/GEMINI.md`.
5. **Your own API keys:** used only when the user chooses them. When a plan runs out, nudge. Keeping keys from leaking is the top priority: no one can read them, including the maintainer, open-source users or a web build.
6. **Order:**
   - Quick fixes: #6, #8, #2.
   - Then: #11, #1/#5/#7, auto-resume.
   - Then the rest.

## Decisions (grill round 2, 2026-10-31)

1. **Skills sync.** In onboarding the user picks a **home provider** (Claude for this user). We copy its skills and global instructions one way into the other providers, marking each copy as managed by Agent Kanban. Skills created directly in another provider are left alone. Onboarding and Settings show a short list of the synced skills by name, behind "Show more". A skills library or marketplace like Claude's or ChatGPT's comes later, not now.
2. **Plugin skills** (from Claude's plugin cache, e.g. `mattpocock-skills`, `impeccable`) are synced too.
3. **Invoking skills.** In our composer, `/` lists the same skills for every provider, under the same names. Picking one sends that provider its own form: a slash command for Claude, `$skill` for Codex, a workflow for Antigravity. Outside our app, each provider finds the synced skills by their descriptions.
4. **Context handoff** carries three things:
   - the last real messages, about 16k tokens (T3 Code's approach);
   - a pointer to the active spec and its Progress checklist;
   - the project notes file, which the agent updates at the end of each task.
5. **API keys:**
   - Encrypted with the operating system's key store (Electron `safeStorage`; DPAPI on Windows).
   - Write-only in the UI: after saving, only the last 4 characters are shown.
   - Never sent to the web page, never logged, and given only to the provider process's environment when it starts.
   - Turned off in browser mode. No sync or export.
   - An optional spend cap per key; the UI is designed in the design grill.
6. **#11 hooks:** the app may add its hook entry to `~/.claude/settings.json`, with one-click install and remove in Settings.

## Decisions (grill round 3, 2026-10-31)

Enjoy deep dive: `docs/research/2026-10-31-enjoy-deep-dive.md`.

1. **Accounts:** switch in one click, plus a nudge when one runs out. No automatic switching, because of the providers' terms-of-service risk.
2. **New items:**
   - Now: a follow-up queue (pairs with auto-resume) and suggested next steps (up to 3 after a reply).
   - Later: presets and plan advice.
3. **Routines in v1:** a skill or prompt plus a simple schedule (daily, weekdays, a time). They run while the app is open; no cron. The user will trial it and we iterate.
4. **GitHub issues:** one per theme, linking the existing single-feature issues.

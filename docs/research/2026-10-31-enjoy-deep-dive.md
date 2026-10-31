# Enjoy deep dive (follow-up to 2026-10-23)

Date: 2026-10-31 · Sources: enjoy.dev/features (163 features), /pricing, /help (Manual: "Switch agents in a conversation"). All claims are Enjoy's own.

**Bottom line:** Enjoy is no longer free. It's $29/month after a 7-day trial (on 2026-10-23 it was free locally, with a $19.99 Cloud plan). It has moved toward a full developer workspace: previews, Git, worktrees, teams. Its gap is ours to take:
- **It doesn't carry your skills between agents.** `/` runs that agent's own skills only.
- **It has no board of many chats at once.**

Both are central to our ideology.

## What changed since 2026-10-23

- **Price:** free locally became $29/month, with a 7-day trial. "Free and simple for your existing plans" is open ground again.
- **Main screen:** a start page called JOY: what needs you, what's working, recent chats and projects under one message box. It has statuses (Working, Needs you, Completed, Out of usage, Stopped, Failed) counted in the sidebar. **It has no board.**

## How their agent switch works (from the Manual)

- You pick a new agent in the message box. The switch happens when you send.
- The new agent gets the whole conversation so far, including other agents' replies.
- Each agent keeps its own place. Switching back continues where it left off, with its own model, effort, speed and permission mode.
- "Stop and move to X" hands over work that's in progress.
- Each reply names the agent, model and effort that did it.

## Worth taking (mapped to our list)

| Enjoy feature | Our item | Note |
|---|---|---|
| Switch agents mid-conversation; each agent keeps its own place | Handoff | Combine with T3 Code's token budget and our skill sync |
| Wait and resume after a limit; Out of usage status | Auto-resume | Add "Out of usage" as a needs-you reason in the copy |
| Several accounts; an account per project; automatic switching | Accounts | T3 Code refuses automatic switching over terms-of-service risk; decide |
| Free Codex resets; plan advice ("a smaller plan would do") | Usage | Plan advice fits the "get the most from what you pay" message |
| Effort levels: Low/High, a shortcut, or "go high on this" | Effort | Validates "the user picks"; the phrase trigger is a nice touch |
| Presets (agent + model + effort + permissions saved under a name) | New | Simple for non-technical users |
| Workflows + schedules (daily, weekdays, cron), Gallery, "made by your agent" | Routines | Their workflows are saved prompts; ours could be skills plus a schedule |
| Queue follow-ups while it works; editable queue | New | Pairs with auto-resume (messages sent while waiting) |
| Suggested next steps (up to 3 after each reply) | New | Strong for non-technical users |
| Questions with choices; readable approvals | Exists | We have permission and question cards |
| Pinned projects in your order; colours and images per project | #1/#5 | "My projects" |
| Search every conversation; select several and act on all | #7, #9 | Bulk Archive/Hide/Delete |
| Import past Claude/Codex conversations | Exists | We do this (and show history) |
| Chimes or short spoken reactions | #2 | |
| Shared docs per project that every agent reads | #3 notes file | Validates the notes-file approach |
| System keychain for secrets | #12 | Same approach as our API keys decision |

## Leave out (developer-heavy or off-ideology)

- Git, worktrees, branches and merges.
- Code editor and file explorer.
- Live preview and processes panel.
- Teams.
- Remote and iPhone access (later, maybe).
- Fork a conversation, sticky notes, quote in message: nice, but not core.

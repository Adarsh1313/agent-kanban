# Competitor research: Enjoy Agentic (JOY)

Date: 2026-10-23 · Sources: [enjoy.dev](https://enjoy.dev/), [enjoy.dev/about](https://enjoy.dev/about/) (all claims are self-reported by Enjoy)

**Bottom line:** Enjoy is very close to what we're building and further along on most fronts. The one big thing it doesn't have is our Kanban board.

## What Enjoy is

- **The product:** a desktop app for Mac, Windows and Linux called **JOY**, which it calls a "superagent". You describe what you want, and it builds software and automations using the Claude, ChatGPT and Gemini plans you already pay for.
- **Agents it runs:** Claude Code, Codex, Grok Build, Antigravity, Muse Code and OpenCode, including local models through OpenCode. Each agent is the lab's own program running on your computer, so there's no model of its own and no markup.
- **Business model:** free on your computer with no limits and no account. **Enjoy Cloud** costs $19.99/month and adds phone and browser access plus other computers, end-to-end encrypted, with a 30-day free trial.
- **Who makes it:** a one-person company ("Mo"), founded in 2026.
- **Its agent list is exactly T3 Code's provider list,** so it may be built on T3 Code, the open-source project we borrow from. That's a guess, not something the site says.

## Side-by-side with our plan

| Area | Enjoy (JOY) | Agent Kanban (our plan) |
|---|---|---|
| Uses your existing subscriptions through each lab's own app | ✅ | ✅ (same approach) |
| Providers | 6 + local models | 3 (Claude Code, Codex, Antigravity) |
| **Main screen** | One agent you talk to, with a "Needs you" state | **A Kanban board of every chat** (Running → Needs you → Review → Done) |
| Usage limits per provider, with reset times | ✅ | ✅ (5-hour + weekly + per model) |
| **Several accounts per provider** (e.g. two Claude accounts) | ✅ switch in one click | ❌ out of scope in our spec |
| **Resumes on its own when a limit resets** | ✅ incl. messages sent while waiting | ❌ (we only show "Limit reached · resets …") |
| **Switch agent mid-conversation, with context carried over** | ✅ | ❌ (our "future handoff" idea; deferred) |
| Picks the best AI per task | ✅ automatic | Partly: we *suggest* the provider with the most room |
| Effort level ("quick one" / "take extra time") | ✅ | ❌ |
| Uses Codex's free usage resets | ✅ | ❌ (T3 Code has this logic) |
| "You're overpaying" plan advice | ✅ | ❌ |
| Scheduled routines (e.g. weekdays 8 am) | ✅ | ❌ |
| Docs/notes in the project, @-mentioned by the agent | ✅ | ❌ |
| Live preview of the app being built, plus a running-servers panel | ✅ | ❌ |
| Phone and browser access, more computers | ✅ (paid Cloud) | ❌ (desktop app is Plan 4; no remote) |
| Imports your existing chats with their original titles | Not mentioned | ✅ |
| Projects: which providers know each project, and what instructions each one reads | Not mentioned | ✅ |
| Connection health and latest-version checks | Not mentioned | ✅ |
| Install and sign-in from inside the app (no terminal) | Implied ("sign in") | ✅ (Plan 3) |
| Price | Free locally; $19.99/mo for Cloud | Undecided |

## What this means

1. **Where we overlap, Enjoy is already shipped and free.** Using every lab's agent on your existing plans with limit tracking is now a crowded space. It isn't enough on its own to stand out.
2. **Our clearest difference is the board.** Enjoy is built around one "superagent" you talk to. We're built around seeing and managing *many* chats at once: what's running, what's waiting on you, what to review. Project awareness, importing your history and connection health support that. It's a real angle: an overview for people running lots of agents in parallel.
3. **They've shipped things we deferred.** The biggest:
   - **Auto-resume after a limit resets.** Cheap for us: we already detect "limit reached" and know the reset time.
   - **Several accounts per provider.** This most directly serves the original goal of getting the most out of weekly and 5-hour limits.
   - **Moving a chat between providers with its context.** This is our handoff idea.
4. **Enjoy validates the core idea.** Someone built the same core and charges for remote access. It also sets a benchmark for what users will expect.

## Recommendation

Keep the board as the centre of the product, and add the three features most tied to the original goal (getting the most out of each limit) to the roadmap:

- [ ] **Auto-resume when a limit resets.** Small; fits Plan 2 or 3.
- [ ] **Several accounts per provider.** Medium; a new plan after Plan 3.
- [ ] **Hand a chat to another provider with its context.** The deferred handoff idea; worth moving up.

Leave out JOY's broader "build anything" features (routines, docs, live previews, cloud) for now. They'd turn us into a direct clone of a free product.

## To decide when re-reading

- [ ] Which of the three recommended features to add, and to which plan.
- [ ] Whether to update the spec (`docs/specs/2026-10-22-agent-kanban-design.md`) and roadmap before Plan 2 gets far.
- [ ] Positioning: lead with "one board for all your agent chats" rather than "one app for every agent".
- [ ] Pricing stance (free local + paid remote, like Enjoy, or something else).

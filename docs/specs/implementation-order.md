# Implementation order for #37, #39–#45

Decided 2026-10-31. #38 (`my-projects.md`) is being built on `feat/my-projects`.

| # | Spec | Issue | Depends on | Why here |
|---|---|---|---|---|
| 1 | `outside-sessions.md` | #37 | none | Round 1 order puts it first; it's self-contained. |
| 2 | `limits.md` | #39 | none | Auto-resume is next in round 1. Its out-of-usage nudge is the entry point for 3 and 6. |
| 3 | `cross-provider.md` | #40 | 2 (the "Continue with Codex" nudge) | It's the core problem. The handoff extends the out-of-usage nudge. |
| 4 | `composer.md` | #42 | none | Small. Routines use its effort. |
| 5 | `chat-management.md` | #41 | #38 merged; 3 slice 8 for Move to project (otherwise hidden) | Touches All chats, which #38 also changes. |
| 6 | `api-keys.md` | #43 | 2 slice 1 | Extends the out-of-usage nudge. |
| 7 | `routines.md` | #45 | 4 and 3 are optional | Falls back to Normal effort and plain prompts. |
| 8 | `several-boards.md` | #44 | #38 merged (reuses its picker) | Pure web; it can go last. |

These can run in parallel without touching the same files: 1 with 4, and 7 with 8.

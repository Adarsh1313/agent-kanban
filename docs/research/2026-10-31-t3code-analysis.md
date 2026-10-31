# T3 Code analysis: what to borrow, what to avoid

Date: 2026-10-31. Repo: `pingdotgg/t3code` (34k stars, confirmed). Read from a bare clone's git objects (checkout failed on Windows long paths); nothing was run. Paths below are inside that repo.

## Bottom line

T3 Code is a developer cockpit (worktrees, diffs, PRs, terminals, MCP, remote hosts). Its engine is more mature than ours: **9 built-in providers**, Claude via the **Claude Agent SDK**, Codex via the **`codex app-server` JSON-RPC protocol**, the rest via **ACP**. It handles provider switching with a **portable text handoff**, pools **usage limits across accounts**, **redeems reset credits**, and runs **scheduled tasks**. It deliberately does *not* do an account auto-switcher (`docs/user/faq.md`, TOS risk), API-key vaults, or deleting the provider's own session files. Borrow its plumbing ideas; do not borrow its UI.

## 1. Providers

| Provider | How it is driven | Evidence |
|---|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` (wraps the CLI, uses its login) | `apps/server/package.json`, `orchestration-v2/Adapters/ClaudeAdapterV2.ts` |
| Codex | `codex app-server` over JSON-RPC, own Effect client and generated schema; supports rollback | `packages/effect-codex-app-server/`, `Adapters/CodexAdapterV2.ts` |
| Antigravity | ACP agent (Google's official), own profile dir and sign-in | `provider/Drivers/AntigravityDriver.ts`, `provider/acp/` |
| Grok, Cursor, OpenCode, Pi, Muse, fx | One package each. OpenCode runs its own server (1.x per thread, 2.x per instance); Pi runs RPC mode | `packages/provider-*`, `docs/internals/providers.md` |
| Anything else | **ACP Registry** driver: a new ACP agent is a registry entry, no code | `packages/provider-acp-registry`, `docs/user/providers-acp.md` |

**Adding one** (`docs/internals/adding-a-provider.md`): pick ACP (registry entry or small flavour over `provider-acp`) or a native `ProviderAdapterV2` (`packages/provider-core/src/server/ProviderAdapter.ts`). The adapter reports a **capabilities** struct (fork, rollback, steering, subagents); the rest of the app reads capabilities and never the provider name. Drivers register in `apps/server/src/provider/builtInDrivers.ts`. A driver kind is the integration; an *instance* is one account/config.

**We lack:** the Codex app-server protocol (we presumably use `codex exec`), OpenCode, Grok, Cursor, Pi, and a generic ACP slot. For non-technical users, ACP-registry plus Codex app-server is the useful part. OpenCode/Grok/Cursor are developer tools; low value for us.

## 2. Cross-provider context

Yes, via a **portable handoff** (`docs/user/portable-handoffs.md`, `docs/internals/context-handoffs.md`, `provider-core/src/server/handoffBudget.ts`):
- Not an AI summary. A budgeted selection of the real messages: recent turns, the original request, command outcomes. Per-item text capped (240 chars for non-message items).
- Default 16k-token allowance (`T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`, 1k-64k). Switching back sends only the delta since that provider last took part.
- Codex gets history as native messages; others get attributed context text. Reasoning and tool state are not carried.
- It includes a pointer so the agent can read omitted history with a thread-reading tool. If the target is full, it starts a fresh conversation with a bounded selection.
- Provider-native resume/fork is used when the same provider and config dir allow it (`selectionTransition.ts`).

## 3. Accounts, keys, limits

| Need | What exists | Evidence |
|---|---|---|
| Several accounts | One *instance* per account: `CLAUDE_CONFIG_DIR`, `CODEX_HOME` (Codex also "shadow home" so two logins share sessions). Switch per thread in the model picker, only among compatible instances. Also in-app ChatGPT sign-in | `docs/user/providers-claude.md`, `providers-codex.md`, `CodexManagedHome.ts` |
| Auto-switching accounts | **Refused on purpose** (TOS risk) | `docs/user/faq.md` |
| API keys | Per-instance environment variables (plus an OpenRouter recipe). No vault of its own; secrets are redacted in Settings | `faq.md`, `providers-claude.md`, `ProviderCredentialStore.ts` |
| Limits/usage | **Usage > Limits** pools all accounts per provider, 5-hour and weekly windows, next-refill time. Reads provider endpoints/local DBs. `/usage-limits` in the composer. Token and API-equivalent cost view | `docs/user/usage.md`, `provider/*UsageLimits.ts`, `Drivers/*Usage.ts` |
| Auto-resume after a limit | **Pauses the turn**, shows "paused until the 5-hour limit resets in 2h", continues after the reset. Driven by the SDK `rate_limit_event` (`resetsAt`). Thread status shows "Limited" | `ClaudeAdapterV2.ts` (~L3930-3960), `thread-sidebar.md` |
| Reset credits ("free resets") | Banked credits are shown as a ticket count with a **Use reset** button. Claude via `api.anthropic.com` (`cedar_ember` program, OAuth token); serialized per login dir with an idempotency key. Not on macOS Keychain | `provider/claudeResetCredits.ts`, `resetCreditCoordinator.ts` |

Our "queue the next message until `resetsAt`" idea matches their design; their reset-credit redemption is something we do not have.

## 4. Effort, schedules, outside sessions, deletion

- **Effort:** a per-model option (`reasoningEffort` / `effort`: Low, Medium, High, Extra High, Max, plus "Ultrathink"/"Ultracode") defined in `apps/server/src/provider/model-manifest.json`; picker in `apps/web/src/components/chat/ComposerModelEffort.tsx`. The model picker owns it, no heuristics.
- **Scheduled tasks:** `apps/server/src/scheduledTasks/` (interval, time-of-day with weekdays, or webhook), run on the host's time zone; pause, resume, run now. Editor is on mobile settings. Needs the server running; no OS scheduler.
- **Outside sessions:** *import*, not live detection. `apps/server/src/project/AgentSessionScanner.ts` scans `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/Y/M/D/rollout-*.jsonl`, and the wizard offers them as projects (active in 30 days, 3+ chats). `AgentSessionImporter.ts` turns one into a resumable thread. The reverse is an **MCP server** so Claude Code/Codex in a terminal can read and start T3 threads (`docs/user/outside-agents.md`). No hooks, no live board of outside runs: **item 11 in our list is ahead of them.**
- **Delete/archive:** T3 owns its own database. Archive, settle, snooze are app states; delete removes T3's thread, not the provider's session file (no provider-file deletion found). Our item 9 (delete the provider file) has no precedent here.
- Codex scanner reads plain `rollout-*.jsonl` (`AgentSessionScanner.ts` ~L1133), consistent with our bug 6 fix.

## 5. Worth borrowing for a simpler UI

1. **Handoff on provider switch** with a delta-only rule and a pointer to older history (cheaper and more honest than an AI summary).
2. **Capabilities struct per provider**, so the UI hides unsupported actions instead of failing.
3. **Instance = account**, chosen from the model picker, only offering compatible ones.
4. **Pooled Limits view** with the next-refill time, and a Limited status on the card.
5. **Paused-until-reset notice** instead of an error, then automatic continue.
6. **Onboarding project import**: git repos first, newest on top, recent ones pre-ticked, "Select all/none" (`welcome-wizard.md`; matches our item 1).
7. **Settle / Snooze** for finished work, with undo toast (`thread-sidebar.md`); fits Review/Done on a board.
8. **Scheduled tasks** with plain weekday and time pickers, plus pause and run-now.

## Avoid (developer-heavy)

1. Worktrees, branches, diffs, PR linking, terminals, `t3.json` run actions.
2. Permission-mode jargon (Supervised / Full access), MCP URLs, pairing codes, remote hosts, Tailscale.
3. Environment-variable and config-dir setup for accounts or keys, and raw model/effort names (Ultrathink, Ultracode). Offer sign-in buttons and "Quick / Thorough".

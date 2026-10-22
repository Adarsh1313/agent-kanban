# SDD ledger — plan: docs/superpowers/plans/2026-10-22-agent-kanban-1-server-core.md

Spec: docs/specs/2026-10-22-agent-kanban-design.md (reachable). Branch: feat/server-core (from main @ ef05179).

## Pre-flight scan

| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T2 | shared types (ProviderId, Column, NeedsReason) → Chat | ok |
| T2 ↔ T3 | Store.saveUsage/lastUsage use UsageReading, which T3 defines | ORDER CONFLICT: T2 needs the type first |
| T3 → T4 | UsageReading, parse fns → UsageService | ok |
| T4 → T8 | UsageService.refresh → ChatService | ok |
| T5 → T8, T9 | HistoryChat, readAllHistory | ok |
| T6 → T7, T8, T10 | ProviderAdapter (+ ping in T10) | ok; T10 extends the interface |
| T6 ↔ T10 | T6: next action respawns a crashed app-server; T10: respawn with backoff 1/2/4 s | CONFLICT on respawn timing |
| T8 → T9 | ServerEvent, ChatService → API | ok; T10 adds connection.updated |
| T9 → T10 | findBinary → ConnectionMonitor | ok |
| T1 self | tests vs nextState spec | ok (14 cases) |
| T2 self | createChat default column 'running' vs Chat.column null for history | ok: history chats are not stored until continued |
| T5 self | fixtures made by script, read-only hash check | ok |
| T8 self | error copy shows "Codex isn't signed in" only as example | needs per-provider display names |
| T1 self | scaffolding has no .gitignore; node_modules and .superpowers would be committed | gap |

## Rulings

- Ruling: Move `UsageWindow` and `UsageReading` type definitions into Task 2's shared-types step; Task 3 only consumes them — Task 2's store cannot compile without them — if wrong: trivial type move.
- Ruling: User-initiated actions (startChat/sendMessage/stop) respawn a crashed Codex app-server immediately (T6 test stands); automatic respawns triggered by health pings follow T10's 1 s → 2 s → 4 s … 60 s backoff, and T10 must keep T6's test green — keeps user actions responsive while preventing crash loops — if wrong: a crash-looping binary gets one extra spawn per user action.
- Ruling: Display names in user-facing copy are `Claude Code`, `Codex`, `Antigravity` (from the design's APP map) — design brief uses these — if wrong: string changes only.
- Ruling: Task 1 also adds `.gitignore` with `node_modules/`, `.superpowers/`, `*.db`, `*.db-wal`, `*.db-shm` — workspace scratch and deps must not be committed — if wrong: none.

## Progress
- Ruling: adapter `stopped` event → needs_you/stopped (same as user.stop); turn.completed in any needs_you state stays put — a stop or error must stay visible — if wrong: one case in columns.ts.
Task 1: minor (deferred): test title says deltas but only tests tool.call; no test for done→running via user.message or for `stopped`
Task 1: minor (deferred): RUNNING/REVIEW/DONE singletons in columns.ts are shared mutable objects
Task 1: minor (deferred): no engines field for Node >= 22
Task 1: complete (commits ef05179..20b8f08, review clean)
Task 2: minor (deferred): tool-call upsert test asserts nothing (no read API)
Task 2: minor (deferred): title not trimmed / leading blank line → ''; no Store.close(); no indexes on messages(chat_id), chats(provider, session_ref); appendToMessage on unknown id is silent
Task 2: complete (commits 20b8f08..98d9061, review clean)
- Ruling: `suggest` never returns a provider without numbers (returns null if none of the allowed ones has numbers); the web app (Plan 2) preselects the first allowed provider without the "Suggested" tag in that case — matches the design ("we can't suggest it until it does") and avoids recommending a provider whose room is unknown — if wrong: a few lines in suggest() plus its tests.
Task 3: minor (deferred): score uses only windows present (untested); NaN resetsAt tie-break; Codex usedPercent not validated; model windows unfiltered by duration
Task 3: complete (commits 98d9061..c98a4f0, review clean)
Task 4: minor (deferred, PRIORITY for final review): onUpdate throwing → `void this.refresh()` in start()/interval becomes an unhandled rejection (can crash Node)
Task 4: minor (deferred): reader returning status 'error' with [] windows blanks last good numbers; saveUsage failure reported as read failure; no tests for refresh() all / latest() / stop()
Task 4: complete (commits c98a4f0..552e699, review clean)
Task 5: minor (deferred): "sorts newest first" test asserts nothing; no garbage-.zst test; full zst decompress per rollout; JSON.parse on every Claude line; fallback title keeps newlines; possible duplicate Codex ids; sync SQLite
Task 5: complete (commits 552e699..b6e8b99, review clean)
- Ruling: Windows npm shims are resolved to their real target (`resolveSpawnTarget`: .js → node + script, .exe → exe) instead of spawning with shell:true — shell:true orphans the real process on kill and keeps pipes open; Task 7 must pass the resolved claude.exe as pathToClaudeCodeExecutable — if wrong: one helper.
- Ruling: process kill on Windows uses `taskkill /PID <pid> /T /F` (tree kill) — codex.js spawns a native child — if wrong: orphaned codex processes.
Task 6: fix round 1/5 dispatched (C1 Windows .cmd spawn; I1 timeouts; I2 re-attach threads after respawn; I3 close/kill hang; I4 stop before turnId; M1–M5 + test gaps) — FIX_BASE f1b0be8
Task 6: fix round 1/5 (10 addressed, 0 open; commits f1b0be8..c46c691)
Task 6: minor (deferred → carry into Task 10): stop() dropped while attach()'s thread/resume is in flight after respawn; a request timeout after startup doesn't recycle a hung process; taskkill non-zero has no child.kill() fallback; M3 stderr suffix untested
Task 6: note: callers must pass the full resolved .cmd path (findBinary in Task 9) — bare `codex` would fail on Windows
Task 6: complete (commits b6e8b99..c46c691, review clean after 1 fix round)
- Ruling: Claude usage reads reuse one long-lived idle "usage query" (created lazily, 15 s timeout, recreated on failure, closed on dispose) instead of spawning a claude process every 60 s — keeps the 60 s cadence from the spec without a process per minute — if wrong: one idle claude process stays open while the server runs.
Task 7: fix round 1/5 dispatched (I1 dispose misses starting chats; usage-query ruling; M3 crash close + listener isolation; M4 queue close; M5 parallel bounded interrupt; M6 request before init; M7 messageId) — FIX_BASE 672919a
Task 7: minor (deferred): Step 5 not verified in `claude --resume` list; PowerShell summary not re-run on real CLI; stop denies pending permissions without interrupt:true
Task 7: fix round 1/5 (8 addressed, 0 open; commits 672919a..d53efdf)
Task 7: minor (deferred → final review/Task 10): shared usage query's output iterator is never drained (possible buffering over long uptime — confirm with real CLI); failed readAt stamped at call start; result-with-session_id before init resolves startChat then errors
Task 7: complete (commits c46c691..d53efdf, review clean after 1 fix round)
Task 8: fix round 1/5 dispatched (I1 failed-start chats unrecoverable; I2 active-elsewhere on send/resume; I3 send during pending start; M1–M8) — FIX_BASE 8022551
Task 8: fix round 1/5 + 2/5 re-reviewed (12 addressed, 1 new Important: process-wide error dedupe drops other chats' failures; commits 8022551..eb522c2)
Task 8: fix round 3/5 dispatched (R1 per-chat dedupe; R2 same-tick double begin; R3 concurrent continueHistory duplicate rows) — FIX_BASE eb522c2
Task 8: note → Task 9 e2e must exercise Codex stop→send (thread/resume on an already-loaded thread is unverified against real Codex)
Task 8: minor (deferred): false-positive window (≤15 s) after a Claude stop if the CLI writes the .jsonl >2 s after our last event
Task 8: fix round 3/5 (3 addressed, 0 open; commits eb522c2..8278769)
Task 8: minor (deferred): detached docstring above begin(); dedupe keyed on Error object could suppress a reused Error for same chat
Task 8: complete (commits d53efdf..8278769, review clean after 3 fix rounds)
- Ruling: Codex model fallback — if ~/.codex/config.toml names a model not in `model/list` for the signed-in account, new threads use the account's isDefault model and the adapter exposes a modelNote (never writes the user's config) — the user's config `gpt-5.6-sol` broke every Codex chat — if wrong: chats use a different model than the user configured (only when theirs is unusable).
- Ruling: error copy shows the provider's own message for non-auth, non-crash failures ("<name> couldn't continue: <message>") — the generic copy hid the real cause in e2e — if wrong: copy change.
- Ruling: GET / with ?token= returns 200 "Agent Kanban server is running." so the printed URL works; ?token= accepted only for GET / and the WS upgrade — if wrong: one route.
Task 9: e2e (first run): Claude PASS, usage/history PASS (138 chats), Codex a/b FAIL on user config model gpt-5.6-sol
Task 9: fix round 1/5 dispatched (I1 SIGHUP/SIGBREAK; X1 Codex model fallback; X2 error copy; M1–M8; tests; Codex e2e re-run) — FIX_BASE ef9105b
Task 9: fix round 1/5 (16 addressed, 0 open; commits ef9105b..4833389). E2E Codex (b) stop→send on loaded thread PASS; (a) PASS by file evidence (script's wait fixed, not re-run)
Task 9: fix round 2/5 dispatched (C1 malformed upgrade URL crashes server [confirmed gap in this task's code]; C2 over-broad auth regex; M1 config section scoping; M2 truncate provider msg; M3 stale note + pagination; M4 fallback on resume) — FIX_BASE 4833389
Task 9: fix round 2/5 (6 addressed, 0 open; commits 4833389..61610a3)
Task 9: minor (deferred): model/list pagination untested; unknown after 5 pages treated as unusable; SIGHUP/SIGBREAK paths not exercised; e2e (a) wait fix not re-run
Task 9: complete (commits 8278769..61610a3, review clean after 2 fix rounds)
Task 10: e2e (first run): Claude 2.1.308 + Codex 0.163.0 connected, equal to latest; killed Codex app-server → degraded at +61 s, connected at +66 s
- Ruling: Claude signedIn = tokenSource rule when present, else email present — real accountInfo() on 2.1.308 has no tokenSource — if wrong: a signed-out user with a cached email shows connected until a request fails.
- Ruling (R-A, amends 3b): a Codex request timeout only marks the process SUSPECT; recycle needs a second probe timeout AND (no active turns OR 120 s without notifications) — avoids killing working chats on one slow reply — if wrong: a truly stuck process lingers up to 2 min longer.
- Ruling (R-B): backoff gives up after 4 consecutive failures (initial + 1/2/4 s), matching the brief's test — if wrong: one extra spawn.
- Ruling: adapters are created lazily through a shared AdapterRegistry so providers installed after start work without a restart — if wrong: small indirection.
Task 10: fix round 1/5 dispatched (I1 deliberate recycle false crashes; I2 give-up copy; I4 late installs; I5 sign-in changes; R-A suspect logic; M6–M10) — FIX_BASE 1d2882e
Task 10: fix round 1/5 (11 addressed, 1 open M8 partial, 1 new Important N1; commits 1d2882e..449c37d)
Task 10: fix round 2/5 dispatched (M8 pending restart; N1 unavailable reading for uninstalled; N2–N6) — FIX_BASE 449c37d
Task 10: fix round 2/5 (7 addressed, 0 open; commits 449c37d..dd1d97e)
Task 10: minor (deferred): Codex restartIfIdle returns true while starting (pending restart may clear during start); registry swap disposes idle-but-open chats' adapter after reinstall
Task 10: complete (commits 61610a3..dd1d97e, review clean after 2 fix rounds)
Final review (opus, ef05179..dd1d97e): With fixes — 7 Important (usage error readings blank last-good; timer-path unhandled rejections; AskUserQuestion answers shape; no read-back of open requests/tool calls; restart leaves permission/question cards dead; Claude processes never idle-closed; 5 s degraded retry spawns forever) + minor sweep. Final fix wave dispatched — FIX_BASE dd1d97e
- Ruling: Claude chat queries close after 10 min idle (relaunch with resume on next send) — resident processes per chat for the whole uptime are a resource leak — if wrong: first message after idle takes a few seconds longer.
Final fix wave: 19 items fixed (dd1d97e..8570781), 224 tests; e2e b/c/d/e PASS (Claude AskUserQuestion round-trip works), a FAIL (Codex read-only sandbox in untrusted temp folder)
- Ruling: Codex threads from Agent Kanban use sandbox 'workspace-write' + approvalPolicy 'on-request' (Codex "Auto" mode: edit inside the chosen folder, ask before anything outside); never danger-full-access — the user explicitly picks the folder in New chat — if wrong: Codex can edit files in a folder the user hasn't marked trusted in Codex (user should know this).
Final fix wave re-review: all 21 addressed (dd1d97e..2a14f68)
Final: parked — lock PID reuse after a crash can block start until the lock file is deleted — Ruling: acceptable for now; message should name the lock path (Plan 2 sweep) — if wrong: user deletes ~/.agent-kanban/server.lock by hand once
Final: parked — two simultaneous starts against a stale lock can both run — Ruling: narrow window, accept — if wrong: two servers on one DB
Final: parked — manual check doesn't shorten an already-scheduled long retry; open request at result skips idle close until next result; Codex thread/resume with sandbox params unverified on real Codex; history continue doesn't validate cwd

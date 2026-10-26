# SDD ledger — plan: docs/superpowers/plans/2026-10-23-agent-kanban-3-connect-and-antigravity.md

Branch feat/connect-antigravity from main c112a09. Spec: docs/specs/2026-10-22-agent-kanban-design.md. Plan 2 ledger (parked items): docs/superpowers/ledgers/2026-10-23-web-app-ledger.md.

## Pre-flight scan
| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T3 | AcpClient, JsonRpcProcess {jsonrpc:'2.0'} + onTextLine | ok; JsonRpcProcess today silently drops non-JSON lines (jsonrpc.ts:123) — T1 adds the hook |
| T2 → T3, T4 | resolveAntigravityRelease, installAntigravity, findInstalledAntigravity | ok; only win32-x64 sha is in the plan — the other platforms must be copied from T3 Code antigravityRelease.ts (MIT header) |
| T3 → T4 | AntigravityAdapter.signIn/ping | ok |
| T3 ↔ Plan 2 web | NewChatDialog UNSUPPORTED antigravity; ProjectDetail imports UNSUPPORTED | conflict: T3 removes the server 400 but web still disables Antigravity → ruling R3 |
| T4 → T5, T6 | ConnectState, connect.updated, /api/connect, /api/settings | ok |
| T4 ↔ shared suggest() | `suggest` setting excludes providers | suggest() now lives in packages/shared/src/usage.ts (moved in Plan 2) — pass allowed list filtered by settings |
| T5 ↔ Plan 2 ConnectionsPage | SETUP_NEXT / ANTIGRAVITY_NEXT lines | T5 replaces them with real actions |
| T6 | "Modify apps/web/src/ui/shell/App.tsx" | path is apps/web/src/App.tsx → ruling R2 |
| T7 | apps/server/scripts/e2e-real.ts | exists |
| Each task self-consistency | tests vs code vs files | T1–T7 consistent; T3 Step 5 and T7 need the user (Google sign-in) |

## Rulings
- R1: Plan 2 leftovers folded into Plan 3 as Task 8 (after T7): projects/info folderKey match, NewChatDialog samePath → folderKey, model picker overflow on short windows (max-height + scroll), right-aligned menus clamp, server message duplicate update text, cross-tab notification id from server, Open in app / history transcript if APIs land, card hover-icon overlap, archive collapse animation — user asked leftovers be folded into Plan 3 — if wrong: separate PR.
- R2: Task 6 modifies apps/web/src/App.tsx (plan path typo) — if wrong: none.
- R3: Task 3 also removes the web UNSUPPORTED gate for Antigravity (NewChatDialog + ProjectDetail) once the adapter works; Task 5 replaces the "coming next" lines — keeps server and web consistent — if wrong: one constant.
- R4: The user must do the Google sign-in (T3 Step 5, T7); implementers stop and report NEEDS_CONTEXT with the link printed in their report — never complete or bypass sign-in themselves.
- R5: User-data safety carries over from Plan 2: chats only in fresh temp folders; never send into the user's own conversations; never archive/rename/mark done pre-existing chats; never write tokens/credentials to files.

Task 1: dispatched — BASE c112a09, implementer a3dbe376d6d5c6d1f (opus)
- CI PR #1 (ci/github-actions, worktree ../agent-kanban-ci): Ubuntu failed 2 Windows-assumption tests; fixed 8536a5a (projects name split on both separators; .cmd shim test skipped off win32). Merging PR #1 needs the user's OK.
Task 1: implementer DONE_WITH_CONCERNS — commit 025702e (server 267/267)
- Carry to Task 3: verify against the real agy_acp_server how "authenticated" is signalled (flag vs empty authMethods vs session/new -32000) and whether the sign-in line goes to stdout or stderr.
Task 1: review — spec ✅, quality needs fixes (Important: auth URL returned raw → return url.href + printable-ASCII only; cancel() must settle pending permission requests per ACP spec; 6 minors)
- Ruling: settle pending permissions in AcpClient (not the adapter) — ACP spec MUST, keeps adapter simple.
Task 1: fix round 1/5 dispatched — FIX_BASE 025702e
Task 1: fix round 1 done — commit da2f659 (server 274/274); scoped re-review dispatched
- Carry to Task 3: confirm the real sign-in link passes the stricter filter (path allowlist, key=value query parts, valid % escapes).
Task 1: complete — commits 025702e..da2f659; re-review clean (6/6). Realistic Google OAuth URL accepted unchanged.
- Ruling R6 (overrides plan Task 4 "cmd /c start"): openBrowser never goes through a shell — Windows: spawn `rundll32.exe url.dll,FileProtocolHandler <href>` with shell:false (argv), macOS `open <href>`, Linux `xdg-open <href>`; only https: — the href legitimately holds & and %XX, which cmd would interpret — if wrong: one function.
- Parked (minor): 1 MiB cap applied after readline buffering (not a memory bound).
Task 2: dispatched — BASE da2f659, implementer a537feb7de6108292 (opus)
Task 2: implementer DONE_WITH_CONCERNS — commit de77923 (server 284/284); Linux uses built-in zip reader (GNU tar can't read zip); Windows calls System32 tar.exe by path
Task 2: review — spec ✅ (all 6 release rows verified vs T3 86534db4), quality needs fixes (concurrent installs, Windows cancel leftovers, crashed-run leftovers; minors)
- Ruling R7: one extraction path everywhere = built-in zip reader with allowlist (exe + harness at exact sizes from T3), zip64 extra fields tolerated; System32 tar dropped — one policy, tested on the dev box, no tar/SystemRoot dependence — if wrong: reader fails on real archive → caught by Task 3 real install.
Task 2: fix round 1/5 dispatched — FIX_BASE de77923
Task 2: fix round 1 done — commit 77e8683 (server 287/287); single-flight joiners share first caller's signal (OK: ConnectService allows one op per provider); scoped re-review dispatched
Task 2: complete — commits de77923..77e8683; re-review clean (all items; release table incl. exe/harness bytes verified vs T3)
- Parked (minor, hash-pinned so unreachable): zip64 extra-field bound, EOCD comment check, local-header cross-check, sweep prefix edge, onProgress throw after rename.
- Ruling R8: Task 3 Step 5 split — the implementer does Steps 1–4 plus a script `apps/server/scripts/try-antigravity.ts` (install to the real home, signIn printing+opening the Google link, then a temp-folder chat "reply with the single word ok", then an optional session/load check) and reports how auth/stdout/link-path actually behave on the real binary; the controller runs the script with the user for the Google sign-in — a subagent can't hand the browser step to the user.
Task 3: dispatched — BASE 77e8683, implementer a9396a10bf74ba1d8 (opus); real download approved for script steps (a)(b), no sign-in by the agent
Task 3: implementer DONE_WITH_CONCERNS — commits dc6bfd8, a9a88f9 (server 317/317, web 323/323). Real binary: no auth flag, 4 authMethods (oauth-personal first), signed-out shows at session/new -32000; sign-in line + logs on stderr; agent opens the browser itself; ~40 s cold start (PyInstaller unpack 200–330 MB to TEMP), ~140 MB RAM.
- Ruling R9: Task 4 must NOT call openBrowser for Antigravity (the agent opens it itself) — only expose signInUrl for "Open the browser again" — avoids two tabs.
- Ruling R10: health must not keep the Antigravity agent running just to check — derive installed/version from the install folder + release table and signedIn from settings auth.type; spawn only for chats/sign-in, and shut it down when idle — 40 s/140 MB/300 MB per check is too heavy — pending reviewer view.
- Accepted: usage_update is per-chat context tokens, not account limits → usage stays unavailable.
Task 3: review — spec ❌ (R10 violated: agent spawned at server start, never idles out; revoked login stuck connected; allow could widen to allow_always), 9 minors
- R10 confirmed (reviewer agrees): broken binary / revoked login surface at first chat instead of health — acceptable.
- Parked (pre-existing): Linux killTree may orphan PyInstaller child (detached + process.kill(-pid)) — final review.
- Carry to Task 4: ConnectService enforces 5-minute Antigravity sign-in via abort (authenticate has 24 h timeout).
Task 3: fix round 1/5 dispatched — FIX_BASE a9a88f9
Task 3: fix round 1 done — commit 999dd3f (server 325/325, web 323/323); scoped re-review dispatched
Task 3: re-review clean (all items). Fix round 2/5 dispatched for 3 recommended minors (folder version for health, idle re-arm at startChat, clear learned on session success) — FIX_BASE 999dd3f
- Parked (minor): startedHere abort may fail a joined startChat; crash-probe degraded report delayed one cycle.
Task 3: fix round 2 done — commit 5404061 (server 328/328, web 323/323); controller-verified small diff. Steps 1–4 complete; Step 5 (real sign-in with the user) pending.
- Ruling R11: start Task 4 while Task 3 Step 5 (user sign-in) is pending — Step 5 only verifies; Antigravity sign-out behaviour settled from binary evidence now, confirmed at Step 5 — if wrong: small follow-up.
Task 4: dispatched — BASE 5404061, implementer a4c0aa0df5eccc5dd (opus)
Task 4: implementer DONE_WITH_CONCERNS — commit 5dc168f (server 363/363, web 323/323). Antigravity logout via agentCapabilities.auth.logout (found in binary source). Added POST /api/connect/:provider/open (opens saved signInUrl via openBrowser).
- Carry to T7: confirm real `claude auth login --claudeai` / `codex login` open the browser themselves and their link/status output.
- Flaky: antigravity-install "abort mid-download" failed once under load — watch.
Task 4: review — spec ✅, quality needs fixes (Important: no host allowlist on captured sign-in link); minors; also update must recycle the adapter (reviewer's unverifiable b)
- Carry to Task 5/6: web reducer recomputes `suggested` with all USAGE_PROVIDERS on usage.updated — must respect settings.suggest.
Task 4: fix round 1/5 dispatched — FIX_BASE 5dc168f
Task 4: fix round 1 done — commit d46777a (server 374/374, web 323/323); scoped re-review dispatched
Task 4: complete — commits 5dc168f..d46777a; re-review clean (7/7; allowlist bypass attempts all rejected)
- Parked (minor): signOut idle check vs start() separated by an await; recycle retry uncapped while busy (unref'd, one timer).
Task 5: dispatched — BASE d46777a, implementer a076037ff598adf0b (opus)
Task 5: implementer DONE_WITH_CONCERNS — commit a8fae9c (server 374/374, web 341/341). Concerns: Try again guessed (ConnectState lacks last op), no success toast (finish vs cancel indistinguishable), updating shows progress view.
- Ruling R12 (pending review): ConnectState gains `lastOp` and `outcome: 'done'|'cancelled'|'failed'|null` (server) so web can offer Try again for the right action and toast "Connected" — if wrong: two fields.
Task 5: review — spec ✅ (copy matches design), quality needs fixes (I1 stale error after outside fix; M1–M8). R12 confirmed with lastOp/outcome; server clears message/outcome when health contradicts.
- Accepted deviation: updating shows progress view + Cancel instead of design's "Updating…" button.
- Watch: shell perf test failed once under heavy load (414 ms).
Task 5: fix round 1/5 dispatched — FIX_BASE a8fae9c
Task 5: fix round 1 done — commit 3275372; full run 2 timing flakes (codex initialize timeout 300 ms; projects render 1000 ms) pass alone
Task 3 Step 5 (real check with the user, 2026-10-26): PASS. Cold start 111 s (not 40 s) before initialize; no auth flag (null); authMethods oauth-personal first; sign-in line on stderr, URL https://accounts.google.com/o/oauth2/v2/auth with redirect_uri 127.0.0.1:<port>/ accepted by the filter; user signed in in ~12 s; agent wrote auth.type='oauth-personal' to ~/.gemini/antigravity-acp/settings.json; ping signedIn true; temp-folder chat: session/new took ~38 s, turn.started → delta "ok" → message.completed → turn.completed (model gemini-3.8-flash-high). session/load (--load) not tried.
- Carry: cold start can exceed 100 s → UI must say "Starting Antigravity… (this can take a couple of minutes the first time)"; any start/initialize timeout must be ≥ 180 s. Check in final review.
Task 5: complete — commits a8fae9c..3275372; re-review clean (R12, I1, M1–M8)
- Parked (minor): noteHealth misses a stale failure when health flipped mid-op (no change after finish); types.ts comment on lastOp wrong.
Task 6: dispatched — BASE 3275372, implementer a78e0c455d5735f2a (opus); onboarding shown only after s.loaded and onboarded=false; Antigravity 'can take a couple of minutes' note
Task 6: implementer DONE_WITH_CONCERNS — commit ba2a83c (server 377/377, web 363/363). Server onboarded=false (new settings table default) → user will see onboarding once. Switch save ~2 s on real data (second click ignored). Preview servers stopped.
Task 6: review — spec ✅ (copy verbatim), quality needs fixes (I1 switch lock swallows second click, shared with Connections; M1–M7)
- Accepted deviations: 12-chip cap + "+N more", Cancel on install row, desktop default off, "Windows will ask to allow notifications." kept verbatim (raise copy question with user).
Task 6: fix round 1/5 dispatched — FIX_BASE ba2a83c
Task 6: fix round 1 done — commit d212299 (server 377/377, web 368/368); Connections switch test rewritten to last-click-wins (intended); scoped re-review dispatched
Task 6: complete — commits ba2a83c..d212299; re-review clean (8/8)
- Parked (minor): onboarding `seen` count flashes N→0 after re-enabling; failed refetch leaves list stale till resync.
- Open question to user: "Windows will ask to allow notifications." → "Your browser will ask…"?
- Ruling R13 (Task 7): run the UI e2e against a TEMP AGENT_KANBAN_HOME (fresh DB → onboarding shows and can be finished there; real Antigravity download + checksum into the temp home); provider homes stay real (Claude/Codex/Antigravity already signed in). The user's real ~/.agent-kanban settings stay untouched (they still see onboarding once). Step 3 (cancel sign-in) can't run against a signed-in Google account → covered by tests; record as such. Chats only in fresh temp folders (R5).
Task 7: dispatched — BASE d212299, implementer a14d990801bbfc5cb (opus), temp AGENT_KANBAN_HOME
Task 7: implementer DONE_WITH_CONCERNS — commits 8473a07, 6d14ddd, 7d0c202 (server 378/378, web 369/369). E2E: all three providers reached Review; Antigravity install 13 s; Antigravity first chat ~85 s cold. Found: Antigravity 1.3.0 picks ~/.gemini skills folder as cwd (sorted first) → fix prepends the chat folder to the first prompt.
- Ruling R14: accept the first-prompt folder line for Antigravity (only reliable fix found; Agent Kanban shows the user's text unchanged; Antigravity's own transcript shows the extra line) — tell the user — if wrong: revisit when Google fixes cwd handling.
- Final review items: POST /api/chats blocks until Antigravity session/new (~1–2 min) → return early?; approved edit shows failed+done step pair; permission card copy "wants to run a command" for edits; Ready step claims notifications on when browser blocks them.
- Side effect: ~10 test conversations now in the user's real provider histories (8 Antigravity, 1 Claude, 1 Codex) — tell the user.
Task 7: complete — commits 8473a07..7d0c202; review Approved (R14 narrow: first prompt of new Antigravity session only; stored text unchanged). Sign-in step not exercised live (already signed in) — say so in the summary.
Task 8 (R1 leftovers + Plan 3 follow-ups, brief task-8-brief.md, 13 items): dispatched — BASE 7d0c202, implementer a5c09f5300a8d6891 (opus)
- User (chat, 2026-10-26): keep "Windows will ask to allow notifications."; "Merge into main" (PR #1) → merged as 1c1445b. feat/connect-antigravity must merge origin/main before its own PR (picks up CI + the Linux name fix).
Task 8: implementer DONE_WITH_CONCERNS — 10 commits 86374ba..9e79063 (server 390/390, web 385/385 x3). Concerns: Stop while starting waits for session/new; item 8 same-title merge may not match real titles (Task 7 saw 'Run create_file?' vs edit_file).
Task 8: review — spec ❌ (item 8 built on invented fixture, never matches real titles; item 9 misses Claude PowerShell), minors incl. stop-after-start
- Ruling: item 8 keeps the feature with a reason-based rule (held "approved but never executed" + later done edit/delete/move call in the same turn), title rule removed.
- Item 6 padding needs a real-browser look → final review / controller browser check.
Task 8: fix round 1/5 dispatched — FIX_BASE 9e79063
- User (chat): "Keep going, merge into main once fixes pass" — authorizes merging feat/connect-antigravity into main (via PR with green CI) after Task 8 fixes + final review fixes pass.
Task 8: fix round 1 done — commit 471429e (server 393/393, web 386/386 x3); scoped re-review dispatched
Task 8: complete — commits 86374ba..471429e; re-review clean (all items). Minors carried to final fix: stop-while-starting race (drop turn.started/request.opened/turn.completed until terminal event for user-stopped chats), start failure after stop stays stopped, anchor acpAction title regex, send right after stop-while-starting race.
Final review: dispatched — range c112a09..471429e
Final review: ready after fixes — I1 stop-while-starting races, I2 stale health after a successful op, I3 Antigravity sign-in copy/timer during cold start, I4 verify real CLI auth commands read-only; P1 POSIX process group; minors. Brief final-fix-brief.md.
I4 verified read-only by controller (2026-10-26): `claude auth login --claudeai` exists (subscription, default); `claude auth status --json` → {"loggedIn":true,...}; `codex login` + `codex login status` exist; status prints "Logged in using ChatGPT" on STDERR, exit 0 — runner's onOutput merges stdout+stderr, so /\bLogged in\b/ matches. No sign-in/out performed.
Final fix: dispatched — FIX_BASE 471429e, implementer ac83c10826d498e58 (opus)
Final fix: DONE_WITH_CONCERNS — commits 43edd4e..f6bb138 (server 402/403 +1 POSIX skip, web 391/391 x3); P1 untested until Ubuntu CI; scoped re-review dispatched
Final fix re-review: all addressed except I2 residual (Important: "Checking…" sticks when post-op health equals current — publish only broadcasts on change). Adjudicated load-bearing → targeted residual fix dispatched (+ stop transitions first, second-tab refetch on showChats change).
- Parked: Codex stop-while-starting race with a quick Send (pre-existing); STEP_SIGN_IN shown before link (cosmetic); "Antigravity didn't start. Try again." copy to add to design/connections.js.
Final fix residual: commits 7f8ad56, 23e2da3, e3679ab (server 404 + 1 POSIX skip, web 394, x3) — controller-verified diff (post-op health always broadcast; stop parks first; second-tab refetch). Final review closed. Next: merge origin/main, PR, CI on Windows + Ubuntu, merge (user-authorized).

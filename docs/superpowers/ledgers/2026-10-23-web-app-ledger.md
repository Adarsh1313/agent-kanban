# SDD ledger — plan: docs/superpowers/plans/2026-10-23-agent-kanban-2-web-app.md

Spec: docs/specs/2026-10-22-agent-kanban-design.md (reachable). Branch: feat/web-app (from main @ f04f6af). Server API from Plan 1 (done).

## Pre-flight scan

| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1 → T2–T12 | routes, Project/ProjectInfo/ModelOption types → client | ok |
| T1 ↔ Plan 1 | GET / landing behaviour | ok: plain text kept for non-HTML Accept; console moves to /console |
| T2 ↔ root scripts | `npm test` runs `node --test "apps/*/test/**/*.test.ts"` | CONFLICT: would pick up vitest files in apps/web/test |
| T2 ↔ user | launch.json "design" → Vite dev on 3005 | CONFLICT with user's port choice (prototype on 3005) |
| T2 → T3 | client, socket → loadAll | ok |
| T3 self | AppNotification.kind typed as ServerEvent['kind'] | type error (not all union members have kind) |
| T3 self | "Started in" filter needs startedHere | Chat has no such field |
| T3 → T5 | toolCalls loaded per chat on open | board activity line needs latest tool call for running chats on first load |
| T4 → all | primitives | ok |
| T6 self | Copy resume command | verified: `codex resume [SESSION_ID]`, `claude --resume <id>` |
| T1 self | Claude models via SDK supportedModels() | verified exists (sdk.d.ts:3066, ModelInfo.value) |
| T12 self | e2e needs built web served by server | ok via T1 static |

## Rulings

- Ruling: root `npm test` runs `node --test "apps/server/test/**/*.test.ts"` then `npm test -w apps/web` (vitest run); web tests never run under node --test — otherwise the suite breaks — if wrong: script change.
- Ruling: Vite dev server takes 3005 per the plan; the static prototype moves to 3007 (launch.json "prototype") — the real app supersedes the mock; the user is told — if wrong: swap two ports.
- Ruling: `AppNotification.kind` = `Extract<ServerEvent, { type: 'notification' }>['kind']` — compile fix — if wrong: none.
- Ruling: "Started in" filter: chats on the board (column ≠ null) count as "Agent Kanban"; history-only chats count as "the provider's own app" — no startedHere field exists — if wrong: filter semantics only.
- Ruling: on initial load and after resync, fetch tool calls for every running chat so the activity line shows the current step — if wrong: N small requests at load.

## Progress
Task 1: minor (deferred, PRIORITY): listModels on both adapters ignores crash/ping backoff → can respawn a crash-looping provider
Task 1: minor (deferred): PATCH title length checked untrimmed; snoozedUntil accepts non-ISO; empty PATCH bumps updated_at; pin/rename/snooze bump updatedAt (affects ordering); project path normalization (trailing slash, / vs \); traversal status 401 vs 404; no Referrer-Policy/nosniff on shell; projectInfo unbounded readdir + rebuilds all projects per call; missing MIME types
Task 1: complete (commits f04f6af..4569a92, review clean)
Task 2: minor (deferred): readToken stores before stripping URL (storage throw leaves token in URL); readToken per request; probe fetch without AbortController; launch.json reformatted
Task 2: complete (commits 4569a92..55f601d, review clean)
Task 3: note (PRIORITY final): two jsonrpc timing tests flaky under full-suite load (pass alone)
- Ruling: server adds ServerEvent `request.closed {chatId, requestId}` broadcast on every answer/close — two-tab consistency with multiple open requests needs it — if wrong: one extra event type.
Task 3: fix round 1/5 dispatched (I1 in-progress messages; I2 merge not replace; I3 snapshot drops archived; request.closed ruling; M1,M4,M5,M7,M8) — FIX_BASE a98238b
Task 3: minor (deferred → Task 4): snooze expiry needs a timer to re-render
Task 3: fix round 1/5 (9 addressed; 1 new Important: suffix-check delta join duplicates/drops text; commits a98238b..3ef8679)
- Ruling: message.delta carries `offset` (stored length before append); client applies deltas idempotently by offset; server finalizes partial messages with message.completed on stop/error/limit — the only robust way to merge fetched and streamed text — if wrong: one extra field per delta.
Task 3: fix round 2/5 dispatched — FIX_BASE 3ef8679
Task 3: fix round 2/5 (3 addressed, 0 open; commits 3ef8679..4d24fcb)
Task 3: minor (deferred): page loaded mid-stream refetches every running chat once; late Codex delta after stop can cause a duplicate message.completed; partials map not cleaned on archive
Task 3: complete (commits 55f601d..4d24fcb, review clean after 2 fix rounds)
Task 4: fix round 1/5 dispatched (I1 StrictMode toast; M1–M9 a11y/perf/tokens) — FIX_BASE 3a089a5
Task 4: note → Task 9 must add the F shortcut
Task 4: fix rounds 1–2/5 (12 addressed; new: capsule slide regression, dialog trap vs portaled popovers/toasts, nested inert; commits 3a089a5..cbce903)
- Ruling: --color-on-status token (#fff both themes) for glyphs on state circles — design uses white glyphs — if wrong: one token.
Task 4: fix round 3/5 dispatched — FIX_BASE cbce903
Task 4: fix round 3/5 done — commit 1d176a7 (server 242/242, web 120/120); scoped re-review dispatched
Task 4: complete — commits 3a089a5..1d176a7; re-review clean (3/3 addressed)
Task 5: dispatched — BASE 1d176a7, implementer a6e85e69ed2ba8dbf (opus)
Task 5: implementer DONE_WITH_CONCERNS — commit e8a692d (server 242/242, web 140/140)
- Ruling: Review/Done step count shows only when tool calls are loaded; otherwise duration only — avoids N requests per reload — if wrong: add toolCallCount to Chat server-side later.
Task 5: review — spec ✅, quality needs fixes (3 Important: drag listener leak, stopPropagation swallows Esc, focus lost on move; minors 4-9)
- Ruling: add `loaded` to AppState set by applySnapshot — reviewer showed connections heuristic can flash wrong empty state — if wrong: one field.
- Ruling: running→Done drag stays (spec "drag only to Done"); keyboard path via "…" menu Mark done — if wrong: menu item.
- Parked: Review card duration uses updatedAt (drifts on rename/pin) — no end-time field on server — revisit in final review.
Task 5: fix round 1/5 dispatched — FIX_BASE e8a692d
Task 5: fix round 1 done — commit 71ca1f7 (server 242/242, web 150/150); scoped re-review dispatched
Task 5: complete — commits e8a692d..71ca1f7; re-review clean (8/8)
- Parked (cosmetic): 3 hover icons on running cards can overlap long titles; setFresh replaces rather than merges; pointer capture on every press — revisit in final review / Task 6 row menu (Mark done may move into "…" menu).
Task 6: dispatched — BASE 71ca1f7, implementer af6e89a6bff467ee9 (opus)
- Ruling: ui.openHistory (HistoryRef|null), mutually exclusive with openChatId — history chats have no chat id — if wrong: one ui field.
- Ruling: Task 6 registers setRowMenuHandler/setHistoryHandler (nothing did) — panel and menu share ChatActionsMenu — if wrong: move registration.
- Ruling: archive optimistic hide is client-only; restore + toast if api.archive fails — server archive is final — if wrong: UX only.
- Ruling: live browser send only into an e2e-created board chat, never the user's personal history — user data safety — if wrong: one skipped manual check.
Task 6: implementer DONE_WITH_CONCERNS — commit 8b9442a (server 242/242, web 171/171); live "say hi" on e2e chat streamed → Review
- Parked: "Open in <app>" and history transcript need server APIs — not in Plan 2 — revisit Plan 3/4.
Task 6: review — spec ✅, quality approved w/ Important (archive lost on page close) + 8 minors
- Ruling: flush pending archives on pagehide via keepalive fetch with Authorization header — honours user intent, keeps token rule — if wrong: an archive fires a few seconds early on close.
- Parked: archive card height-collapse animation (cosmetic).
Task 6: fix round 1/5 dispatched — FIX_BASE 8b9442a
Task 6: fix round 1 done — commit e589181 (server 242/242, web 179/179); scoped re-review dispatched
Task 6: re-review — 8/9 addressed; open: Thread deps omit calls/loaded (Important); fix round 2/5 dispatched — FIX_BASE e589181
Task 6: fix round 2 done — commit af83b8d (web 181/181); controller-verified 3-line diff (deps + toast dismiss) as scoped re-review
Task 6: complete — commits 8b9442a..af83b8d
Task 7: dispatched — BASE af83b8d, implementer aeb4f9dc0b31ce541 (opus)
- Ruling: client api.models type → Record<ProviderId, ModelOption[]> to match server api.ts:127 — type mismatch from Task 2 — if wrong: type only.
- Ruling: connected = status connected|update_available; others disabled with status text; unknown folder allows any connected provider.
- Ruling: after start, dialog closes and panel stays closed; card arrives via chat.updated.
Task 7: implementer DONE — commit e717ce0 (server 242/242, web 201/201); live Codex chat in temp folder reached Running
- Ruling: Antigravity disabled in the provider picker with the server's reason until Plan 3 enables its adapter — avoids a guaranteed-failing start — if wrong: one condition removed in Plan 3.
- Ruling: use the design's typographic apostrophe (’) in "Hasn’t worked on … yet" — design-brief copy wins over plan's ASCII — if wrong: one char.
Task 7: review — spec ❌ only for the 2 post-hoc rulings; quality needs fixes; fix round 1/5 dispatched (all 9 items) — FIX_BASE e717ce0
Task 7: fix round 1 done — commit 62c2c15 (web 208/208); scoped re-review dispatched
Task 7: complete — commits e717ce0..62c2c15; re-review clean (9/9)
- Parked (minor): note for Antigravity-only project doesn't mention unsupported; late success clears identical prompt after reopen — revisit when Plan 3 enables Antigravity.
Task 8: dispatched — BASE 62c2c15, implementer a97328d60b1e1adc6 (opus)
Task 8: implementer DONE_WITH_CONCERNS — commit f01103b (server 242/242, web 224/224)
- Ruling: "Usage for all providers" returns to all chips (user's own request in brainstorming: provider click shows only its limits plus that button) — design prototype opened a popover instead — if wrong: button target.
Task 8: review — spec ✅, quality needs fixes (Important: "Most room" stale on usage.updated; 6 minors)
- Ruling: move suggest() to packages/shared and recompute in reducer on usage.updated — one source of truth, no wire change — if wrong: shared module move.
- Ruling: perf test warm-up mount, keep 200 ms budget + row counts — removes jit/cold-start noise without weakening the guard.
Task 8: fix round 1/5 dispatched — FIX_BASE f01103b
Task 8: fix round 1 done — commit 4d01082 (server 242/242, web 226/226 x2); scoped re-review dispatched
Task 8: complete — commits f01103b..4d01082; re-review clean (7/7)
Task 9: dispatched — BASE 4d01082, implementer abb6a8e77b21e59c1 (opus)
- Ruling: sidebar provider click sets filters.provider=[p] and clears ui.focusProvider — brief: "Provider focus from the sidebar is the same filter" — if wrong: one handler.
Task 9: implementer DONE — commit 5c65b4f (server 242/242, web 240/240); perf test flaked once more (364 ms)
Task 9: review — spec ✅, quality Approved; minors: dead ui.focusProvider, perf test flake, empty Recent state, column-null test
- Ruling: do the cleanup now (fix round 1) — the perf flake would otherwise hit every later task — if wrong: one extra small commit.
- Accepted: role="menu" holding search/buttons (matches design), single-option category collapse to null.
Task 9: fix round 1/5 dispatched — FIX_BASE 5c65b4f
Task 9: fix round 1 done — commit aafbe80 (web 241/241 x2); controller-verified small diff as scoped re-review
- Parked: perf test uses best-of-3 at 200 ms (no 500 ms ceiling / pure-selector timing) — watch for flakes in final review.
Task 9: complete — commits 5c65b4f..aafbe80
Task 10: dispatched — BASE aafbe80, implementer afa3e55c6ce629179 (opus)
- Ruling: notifier fires only for notifications new since load (not snapshot/resync replays); desktop only when hidden+granted; prefs default {desktop:false, sound:true} — avoids a burst of stale alerts — if wrong: defaults.
Task 10: implementer DONE — commit 09c9b7d (server 242/242, web 264/264)
Task 10: review — spec ✅, quality Approved; minors: two-tab read drift, stale permission state, aria-expanded hardcode, list semantics, enterId, OS notifications outliving read
- Ruling: BroadcastChannel relays mark-read between tabs — Review Focus 5, no server read-state API — if wrong: client-only extra.
- Parked: desktop burst cap (optional).
Task 10: fix round 1/5 dispatched — FIX_BASE 09c9b7d
Task 10: fix round 1 done — commit ee0d879 (web 274/274)
- Ruling: cross-tab read matched by chatId + time window (no shared notification id) — server events carry no id — if wrong: add server notification id later (parked).
- PRIORITY (final review): jsonrpc "request timeout makes the process suspect…" flaking more often (~50% standalone).
Task 10: complete — commits 09c9b7d..ee0d879; re-review clean (6/6)
- Parked (minor): markAllRead NaN if an `at` is unparseable.
Task 11: dispatched — BASE ee0d879, implementer a73f8dc1c231810ac (opus)
- Ruling: NewChatOptions gains optional provider preset (for "New <provider> chat") — brief requires presets — if wrong: one field.
Task 11: implementer DONE_WITH_CONCERNS — commit e501a9d (server 242/242, web 290/290); API+Vite preview servers stopped by implementer
- Ruling: one breadcrumb on project detail (follow prototype: top-bar crumb cleared), update the shell test — duplicate crumbs are noise — if wrong: one condition.
- Parked: "Open folder" needs a server endpoint (Plan 4 desktop, native shell).
Task 11: review — spec ❌ only for the post-hoc single-breadcrumb ruling; quality needs fixes; fix round 1/5 dispatched (7 items) — FIX_BASE e501a9d
Task 11: fix round 1 done — commit 714e8ba (server 242/242, web 294/294); scoped re-review dispatched
Task 11: complete — commits e501a9d..714e8ba; re-review clean (7/7)
- Parked (minor): detail chat list lacks list semantics; stagger-clear matches any bubbled animationend in last li; no test for sidebar empty-projectId.
Task 12: dispatched — BASE 714e8ba, implementer a457435f3356850f3 (opus)
- Ruling: e2e "continue a Claude history chat" only on an e2e-created temp-folder chat; never the user's own conversations — user data safety — if wrong: one manual check by the user.
Task 12: implementer DONE_WITH_CONCERNS — commit a7cbafb (server 242/242, web 303/303); e2e 9/9 PASS on built app (port 3006 left running)
- Parked for final review: popover offscreen overflow can shift app on scrollIntoView (overflow: clip); server message duplicates update text; Antigravity absent from /api/connections (Plan 3).
Task 12: complete — commit a7cbafb; review Approved (minors 1-5 folded into final review)
Final review: dispatched — range f04f6af..a7cbafb (25 commits)
Final review: ready after fixes — 5 Important (jsonrpc flake + red suite, folder keys, stale projects, listModels backoff, popover scroll range), 8 minors + parked triage; brief final-fix-brief.md
- Ruling: one fix dispatch covering all "fix now" items incl. Task 12 minors; Keep list deferred to Plan 3/4.
Final fix: dispatched — FIX_BASE a7cbafb, implementer a5640b713c6cc8e4d (opus)
- User (chat): "Once fixes pass, merge into main and push" — authorizes merge feat/web-app → main + push main after final fix re-review is clean.
Final fix: DONE_WITH_CONCERNS — commits 8090651, c0383b3, 0dca520 (server 252/252, web 322/322, 3x green); scoped re-review dispatched
Final fix: re-review clean (18/18), merge-ready. npm test green (252/252, 322/322).
- Parked for Plan 3 (minor): /api/projects/info matches raw p.id (use folderKey); NewChatDialog samePath duplicate of folderKey; //server/share and \?\ prefixes; model cache not cleared on provider update; one extra projects refetch possible; codex-adapter test 50 ms sleep; New chat model picker overflows on short windows; right-aligned menus pinned to left edge on narrow windows.

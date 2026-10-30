# Projects and chats redesign: decisions (input for the prototype and spec)

Grilled 2026-10-30. Not a spec yet: next is `/prototype` (two sidebar + All chats variants), then `/to-spec` from this
file into `docs/specs/projects-chats-redesign.md`. Terms are in `GLOSSARY.md`. Closes #11 when built.

## Why

The sidebar groups chats under projects and lists look-alike folders (test runs, Claude scratch chats); finding "the
thing I was just doing" means scrolling. New chat's picker had the same problem (now sorted by recency, `c1fc8ba`).

## Survey (from known products, no fresh web research)

Linear and Claude desktop: a short Recents list plus a full list elsewhere. Codex app and T3 Code: threads grouped
under projects, newest project first. Conductor: one workspace per repo, only active ones. Common thread: one
recency-ordered list, projects as labels or groups, noise collapsed or hidden rather than listed.

## Decisions

1. **Scope:** the sidebar, the Projects page and New chat's project picker follow the same rules (order, hiding, naming).
2. **Chat-first sidebar:** **Recent chats** = the 10 most recently active chats, newest first; each row: title, provider
   logo, muted project name; date on hover (#23). No Today/Yesterday labels. Pinned stays above; Providers stays.
   An "All chats" link ends the list. Today's project groups go.
3. **All chats view** (new, in the main area like Projects): every chat, board and history, newest first, searchable,
   filterable by project and provider. The sidebar's search icon opens it with the search box focused.
4. **Projects page** is where you browse by project; sorted by last activity by default.
5. **Hidden projects:** a folder under the OS temp folder is hidden automatically (our test runs: `ak-claude-*`,
   `try-claude-*`, scratchpads). Any project can be hidden by hand (**Hide project** in its menu). Hidden means
   hidden everywhere: sidebar, board cards, New chat picker, onboarding counts. Provider history is never deleted.
6. **Show hidden projects:** one switch, at the top of the Projects page only; hidden projects then show there,
   dimmed, each with **Unhide** (auto-hidden ones too). Hidden projects are saved by the server, so the desktop app
   and browser mode agree.
7. **Claude scratch chats:** the Claude app's folder-less chats (`AppData\Roaming\Claude\scratch-workspaces\…\scratch-*`)
   are grouped into one project named "Claude scratch chats".
8. **Older:** projects with no activity for 30 days fold into a collapsed "Older" group in the sidebar's All chats
   filter and the New chat picker; still searchable.
9. **Folder missing:** a project whose folder no longer exists stays on the Projects page with a "Folder missing" note,
   its chats readable; it is left out of the New chat picker.

## Open for the prototype

- Row density and what the project label looks like in Recent chats.
- All chats: list vs table, where the project/provider filters sit (reuse the Linear-style filter menu?).
- How "Older" reads in the picker.

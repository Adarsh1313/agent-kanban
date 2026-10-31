# My projects and global search

Built from `docs/specs/my-projects-decisions.md`: grilled and prototyped 2026-10-31, variant B "Cards + palette" chosen. The prototype is on branch `prototype/my-projects`.
Terms are defined in `GLOSSARY.md`. Closes #38 (feedback items 1, 5 and 7 in `docs/research/2026-10-31-feedback-and-feasibility.md`).

## Problem Statement

The user has about 60 projects but works in 3–10 of them; the rest are one-off chats or projects that were never pursued. The sidebar's Recent chats list fills up with chats from those projects, so finding the chats of a project they actively work on means scanning or opening All chats. The sidebar also has two New chat buttons and no way to search chats and projects together.

## Solution

During onboarding, the user picks **My projects**: the projects they work on now. The sidebar replaces Recent chats with one card per project in My projects. Each card shows the project's status in one line (running, how many need you, last active), its newest chats, and a link to the rest. The sidebar's New chat button becomes a **Global search** field. Typing in it, or pressing `Ctrl+K`, opens a wide palette with matching projects on the left and chats on the right. Projects left out of My projects are not hidden; they stay on the board, in All chats, in the New chat picker and on the Projects page.

## User Stories

### Picking My projects
1. As a new user, I want an onboarding step that asks which projects I work on, so that the sidebar shows only those.
2. As a new user, I want the projects shown as a grid of tiles with each project's glyph, name, chat count, last activity and provider logos, so that I can recognise them at a glance.
3. As a new user, I want projects active in the last 14 days pre-ticked (at most 5), so that the common case needs one click.
4. As a new user, I want projects with no activity for 30 days folded behind "Older · no activity in 30 days (n)", so that the grid starts short.
5. As a new user, I want a search box above the grid that filters projects by name and opens Older, so that I can find an old project quickly.
6. As a new user, I want Skip to keep the pre-ticked projects, so that skipping still gives me a useful sidebar.
7. As a new user, I want the footer to say how many projects I picked and that I can change it later, so that the choice feels safe.
8. As a user who finished onboarding before this feature existed, I want a one-time "Pick your projects" card at the top of the sidebar, so that I get the same choice without replaying onboarding.
9. As a user, I want Replay onboarding to include the pick step, so that I can redo the choice from scratch.
10. As a user, I want Claude scratch chats offered as one project I can pick, so that my quick chats can be one card.
11. As a user, I want temp-folder and other hidden projects left out of the picker, so that noise never shows up there.

### The sidebar
12. As a user, I want the sidebar ordered Providers → Pinned → My projects, so that what I chose sits below what I pinned.
13. As a user, I want each project in My projects shown as a card, so that each project reads as one unit.
14. As a user, I want a card's header to show the project glyph, name and one summary line (running · N need you · last active), so that I know its state without opening it.
15. As a user, I want a card to list the project's 3 newest chats, board and history alike and leaving out pinned and archived ones, so that I can open what I was just doing.
16. As a user, I want a running or needs-you chat always listed on its card even when it isn't among the 3 newest, so that nothing waiting on me is hidden.
17. As a user, I want "N more in All chats" at the end of a card, opening All chats filtered to that project, so that I can reach the rest in one click.
18. As a user, I want to collapse a card to its header by clicking it, so that I can tuck away a project I'm not looking at right now.
19. As a user, I want collapsed cards to stay collapsed on this device, so that the sidebar stays how I left it.
20. As a user, I want cards ordered by last activity, so that the project I'm working in is on top.
21. As a user, I want Recent chats removed, so that the sidebar has one way of listing chats.
22. As a user, I want an Edit button on the My projects heading that reopens the picker, so that I can change the list any time.
23. As a user, I want "Remove from My projects" on a card, so that I can drop a project without opening the picker.
24. As a user, I want a star on Projects page rows and on a project's page to add or remove it from My projects, so that I can manage it where I browse projects.
25. As a user, I want a project added to My projects automatically when I start a chat in it from this app, so that new work shows up without extra steps.
26. As a user, I want a "New activity in X · Add" hint when a project outside My projects gets activity from outside the app, so that I can add it without it being added behind my back.
27. As a user, I want "Pick the projects you work on" with a Pick button when My projects is empty, so that the sidebar never looks broken.
28. As a user, I want a hidden project to leave the sidebar even if it is in My projects, and to come back when I unhide it, so that hiding works the same everywhere.
29. As a user, I want a project whose folder is missing to stay in My projects, dimmed and saying "Folder missing", with its chats still openable, so that I can still read them.
30. As a user, I want the provider focus and filters to apply to the chats listed on cards as they did to Recent chats, so that the sidebar matches the board.
31. As a user, I want My projects saved by the server, so that the desktop app and browser mode agree.
32. As a user, I want a change to My projects in one window to show in another at once, so that two windows never disagree.

### Global search
33. As a user, I want a search field where the sidebar's New chat button was, so that searching is the first thing in the sidebar.
34. As a user, I want the top bar's New chat button and the `N` shortcut to keep working, so that starting a chat is unchanged.
35. As a user, I want `Ctrl+K` to open search from anywhere, so that I can search without the mouse.
36. As a user, I want typing to open a wide palette over a dimmed page, so that results have room.
37. As a user, I want matching projects listed on the left with their chat counts, so that I can jump to a project.
38. As a user, I want matching chats listed on the right with their provider, status and project, so that I can jump straight to a chat.
39. As a user, I want highlighting a project to show that project's chats on the right, so that I can find a chat by remembering its project.
40. As a user, I want the matched text highlighted, so that I see why each result matched.
41. As a user, I want Enter to open the selected result, with the arrow keys moving through results across both columns, so that I can search using only the keyboard.
42. As a user, I want "See all results in All chats" to open All chats with my query, so that I can go past the palette's short lists.
43. As a user, I want Esc or a click outside to close the palette and clear the query, so that leaving is easy.
44. As a user, I want "Nothing matches" when nothing matches, so that I know to try other words.
45. As a user, I want hidden projects and their chats left out of search results, so that hidden means hidden.
46. As a user, I want search to match titles and project names (not message text), so that results are fast and predictable.

### Accessibility
47. As a keyboard user, I want cards, the "N more" link, Edit, the pick-step tiles and the palette to work with Tab, Enter and Space, so that I don't need a mouse.
48. As a screen reader user, I want each card's header to announce the project, its state and whether it is collapsed, so that the summary line isn't visual-only.
49. As a screen reader user, I want the palette announced as a dialog, its result lists as listboxes, and the selected result announced, so that I can follow where I am.
50. As a user who prefers reduced motion, I want the palette and card collapse to appear without movement, so that nothing animates against my setting.

## Implementation Decisions

- **Setting:** `Settings` gains `myProjects`, a list of folder paths, or **null** when the user has never picked. `null` is what shows the "Pick your projects" card. An empty list is a real choice and shows the empty state. `PATCH /api/settings` validates it like `hiddenProjects` (a list of strings, or null), and it is stored under its own key. The `settings.updated` broadcast keeps windows in sync. No new endpoint.

  ```ts
  interface Settings {
    // …existing fields
    myProjects: string[] | null; // null = never picked
  }
  ```

- **Matching** uses the shared folder key of the project folder, so Claude scratch chats is one entry and path spellings agree, the same way hidden projects match.
- **Auto-add** happens on the web side when a chat starts from this app (New chat, or carrying a history chat on): if the project isn't in My projects and `myProjects` isn't null, it is added with one settings patch. Activity from outside the app never writes the setting.
- **The "New activity" hint** comes from a selector: the newest project outside My projects (not hidden, not Claude scratch chats) with activity in the last 24 hours that started outside the app, dismissed per project for this device. It shows one hint at a time.
- **Selectors:** a "my projects" selector returns visible projects in My projects, by last activity. A "project card" selector returns, for one project, its listed chats (3 newest non-pinned, non-archived chats after provider focus and filters, plus any running or needs-you chat beyond them) and the "more" count. It also gives the summary counts: running, need you (needs-you + review) and last active. They reuse the existing chat-listing and hidden-project rules. The flat Recent chats selector and its 10-row cap are removed.
- **Sidebar:** the Recent section is replaced by a My projects section of project cards (prototype variant B). The card header is a button that toggles collapse and exposes `aria-expanded`; "Remove from My projects" sits in the card's menu. Collapsed state is per device in browser storage, wrapped so it is safe when storage is unavailable.
- **Global search** replaces the sidebar's New chat button with a search field. Focus or typing opens a palette dialog (a scrim plus a centred panel) with the search input, two result columns and a footer link. `Ctrl+K` opens it from anywhere when no other layer is open. The existing sidebar search icon (which opened All chats focused) goes away; "See all results" covers that path.
  - Results: up to 6 projects and 8 chats, newest first, from the same visible chat list as All chats.
  - Highlighting a project switches the right column to that project's chats.
- **Onboarding** gains a "Your projects" step between "Chats found" and "Ready". It lists visible projects as tiles (pick defaults per story 3, with an Older fold and search), and Continue and Skip both write `myProjects`. The same picker opens as a dialog from the sidebar card, Edit and the empty state.
- **Projects page and project page** get a star toggle for My projects (visible label on the project page; an icon button with an accessible name on rows).
- **Design:** new components follow `design/tokens.css` only. `design/DESIGN.md` gets a section for project cards, the search palette and the pick tiles (taken from the prototype, then refined). Motion for the palette and collapse follows my-motion.

## Testing Decisions

- Good tests check what the user sees or what the API returns, not selector internals. Render the app with a seeded store and assert on rows, labels, order and focus; call the HTTP API and assert on the JSON.
- **Seam 1, server HTTP API** (prior art: `project-visibility.test.ts`, `settings.test.ts`). `PATCH /api/settings` with `myProjects`:
  - stores a list;
  - stores `null`;
  - rejects non-string lists without writing;
  - broadcasts `settings.updated`;
  - survives a restart.

  A fresh settings store returns `myProjects: null`.
- **Seam 2, rendered web app** (prior art: `shell.test.tsx`, `hidden-projects.test.tsx`, `onboarding.test.tsx`, `all-chats.test.tsx`):
  - **Sidebar:** shows cards only for My projects, in last-activity order, with the summary line. A card lists its 3 newest chats plus any running or needs-you chat, then "N more", which opens All chats filtered. Collapse persists. `null` shows the pick card, and `[]` shows the empty state. Hidden projects are left out; a folder-missing project is dimmed.
  - **Onboarding:** the pick step pre-ticks recent projects (at most 5), folds Older, and its search filters. Continue and Skip both write the setting.
  - **Auto-add and hint:** starting a chat adds the project. Outside activity shows the hint, and Add writes the setting.
  - **Palette:** `Ctrl+K` and typing open it. Projects and chats match and are highlighted. Highlighting a project switches the right column. Enter opens the result, "See all results" goes to All chats with the query, and Esc closes it. Hidden projects are absent.
  - The existing "1,000 history chats render within budget" test is repeated for the sidebar cards and the palette.

## Out of Scope

- Dragging projects into a custom order (decision 4: later).
- Searching message text.
- Project colours or images chosen by the user.
- Changes to the board, All chats layout (#41) or the New chat picker beyond auto-add.
- Skills sync, the home-provider choice and other onboarding additions from #40.

## Further Notes

- Prototype: branch `prototype/my-projects`, `design/prototype-my-projects.html?v=b`.
- "My projects" replaces the glossary's "Recent chats". Update the README and the onboarding copy that mentions Recent chats.
- Watch the card body at narrow sidebar widths: chat titles get short. The prototype used a smaller chat row inside cards.

## Progress

- [x] Slice 1: server `myProjects` setting (null by default, PATCH validation, broadcast, restart) with API tests
- [ ] Slice 2: web My projects selectors and sidebar project cards (summary line, 3 + running/needs-you chats, "N more", collapse, empty state, pick card, hidden and folder-missing rules); Recent chats removed
- [ ] Slice 3: onboarding "Your projects" step and the shared picker dialog (tiles, pre-tick, Older, search, Skip); Edit and pick-card entry points
- [ ] Slice 4: managing My projects: star on Projects rows and project page, Remove from card, auto-add on new chat, "New activity · Add" hint
- [ ] Slice 5: global search palette (field replaces sidebar New chat, Ctrl+K, two columns, project → chats, keyboard, See all results, Esc)
- [ ] Slice 6: DESIGN.md section, glossary/README/onboarding copy check, close #38

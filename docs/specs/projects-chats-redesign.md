# Projects and chats redesign

From `docs/specs/projects-chats-redesign-decisions.md` (grilled and prototyped 2026-10-30; prototype on branch
`prototype/projects-chats-redesign`, variant A chosen). Terms are in `GLOSSARY.md`. Closes #11.

## Problem Statement

The sidebar groups **Recent chats** under projects (4 projects × 3 chats) and lists every folder any provider ever ran
in, including our own test runs in the temp folder and the Claude app's folder-less scratch chats, each as its own
look-alike project. To find "the thing I was just doing" I scan project groups and scroll. There is no single place to
see or search every chat, and the New chat project picker and Projects page grow with the same noise.

## Solution

The sidebar becomes chat-first: **Recent chats** is a flat list of the 10 most recently active chats, newest first,
each showing its project as a muted label. A new **All chats** view in the main area lists every chat (on the board or
only in a provider's history), searchable and filterable by project and provider; the sidebar's search icon opens it.
Projects you never want to see are hidden: folders under the computer's temp folder automatically, and any other
project by hand. The Claude app's scratch chats collapse into one project, **Claude scratch chats**. Projects with no
activity for 30 days fold into an **Older** group in the New chat picker and the Project filter. A project whose folder
is gone stays readable but can't start new chats. The sidebar, the Projects page and the New chat picker all follow
the same ordering, hiding and naming rules.

## User Stories

1. As a user, I want Recent chats to list my 10 most recently active chats newest first, so that the thing I was just doing is at the top.
2. As a user, I want each Recent chats row to show the provider logo, the title and the project name, so that I know where a chat lives without opening it.
3. As a user, I want the project name muted and right-aligned in the row, so that the title stays the thing I read first.
4. As a user, I want the date to replace the project name when I hover a row, so that I can see when it was last active without opening it (#23).
5. As a user, I want running and needs-you chats marked in Recent chats as they are today, so that I can spot chats that need me.
6. As a user, I want Pinned to stay above Recent chats, so that the chats I chose stay reachable.
7. As a user, I want pinned chats left out of Recent chats, so that a chat isn't listed twice.
8. As a user, I want the Providers section to stay in the sidebar, so that I can still focus one provider.
9. As a user, I want Recent chats to keep respecting the provider focus and filters, so that the sidebar matches the board.
10. As a user, I want an "All chats" link at the end of Recent chats, so that I can see everything when 10 isn't enough.
11. As a user, I want no Today / Yesterday labels in Recent chats, so that the list stays compact.
12. As a user, I want history-only chats (from a provider's own app) in Recent chats, so that work I started elsewhere shows up too.
13. As a user, I want an All chats view in the main area, like Projects, so that I can browse every chat at full width.
14. As a user, I want All chats to list board chats and history-only chats together, newest first, so that there is one list of everything.
15. As a user, I want each All chats row to show status, provider logo, title, project and date, so that I can scan it like the board.
16. As a user, I want to search All chats by title or project name, with the match highlighted, so that I can find a chat by what I remember.
17. As a user, I want a Filter button beside the search that opens the same Linear-style menu as the board, so that filtering works the way I already know.
18. As a user, I want to filter All chats by project and by provider, with active filters shown as removable chips, so that I can narrow the list and undo it.
19. As a user, I want the sidebar's search icon to open All chats with the search box focused, so that I can type straight away.
20. As a user, I want a clear empty state when search or filters match nothing, so that I know to clear them.
21. As a user, I want clicking an All chats row to open that chat (or its history), so that the list is a way in, not just a report.
22. As a user, I want All chats to have its own URL, so that back/forward and reloads keep me there.
23. As a user, I want folders under the temp folder hidden automatically, so that test runs and scratchpads never clutter my lists.
24. As a user, I want to hide any project with "Hide project" in its menu, so that I can remove noise the app didn't catch.
25. As a user, I want a hidden project left out of the sidebar, the board, the New chat picker and onboarding counts, so that hidden really means hidden.
26. As a user, I want hiding a project never to delete its provider history, so that hiding is safe to try.
27. As a user, I want one "Show hidden projects" switch at the top of the Projects page, so that I can find hidden projects again.
28. As a user, I want hidden projects shown dimmed with an Unhide action when the switch is on, including auto-hidden ones, so that I can bring any of them back.
29. As a user, I want hidden projects saved by the server, so that the desktop app and browser mode agree.
30. As a user, I want a hide or unhide in one window to show in another at once, so that two tabs never disagree.
31. As a user, I want the Claude app's folder-less chats grouped into one project named "Claude scratch chats", so that dozens of scratch folders become one row.
32. As a user, I want the Projects page sorted by last activity by default, so that active projects are on top.
33. As a user, I want the New chat picker sorted by last activity, so that the project I'm working in is first.
34. As a user, I want projects with no activity for 30 days folded into a single "Older (n)" row at the end of the picker, so that the list stays short.
35. As a user, I want older projects to appear (dimmed) when I open Older or type in the picker search, so that I can still start a chat in an old project.
36. As a user, I want the Project filter menu to list older projects under an "Older · no activity in 30 days" label, so that filtering by an old project still works.
37. As a user, I want a project whose folder is gone to stay on the Projects page with a "Folder missing" note, so that I can still read its chats.
38. As a user, I want a folder-missing project left out of the New chat picker, so that I can't start a chat that will fail.
39. As a user, I want the same project naming everywhere (sidebar labels, All chats, Projects, picker), so that one project never looks like two.
40. As a keyboard user, I want Recent chats rows, All chats rows and the picker's Older row to work with Enter and Space, so that I don't need a mouse.
41. As a screen reader user, I want each Recent chats row to announce its project and date, so that hover-only information isn't lost.

## Implementation Decisions

- **Project shape** gains whether and why it is hidden and whether its folder exists. Type shape (from the grill, not
  final code):

  ```ts
  interface Project {
    // …existing fields
    hidden: 'auto' | 'manual' | null; // auto = under the OS temp folder
    folderMissing: boolean;
  }
  ```

- **Server project building** (the module that groups chats and history by folder) decides auto-hidden (folder under
  the OS temp folder, compared with the shared folder key), folder missing (the folder doesn't exist on disk), and
  Claude scratch grouping: any folder under the Claude app's `scratch-workspaces` folder (`scratch-*`) is grouped into
  one project named "Claude scratch chats". Its id is that `scratch-workspaces` folder so it is stable.
- **Hidden projects are a setting**: `Settings` gains `hiddenProjects` (a list of folder paths the user hid by hand).
  `PATCH /api/settings` accepts it, validates it is a list of strings and stores it under its own key; the existing
  `settings.updated` broadcast keeps every open window in sync. No new endpoint. Auto-hidden is computed, never stored;
  unhiding an auto-hidden project lists it in a second setting, `unhiddenProjects`, and a hand hide wins over both.
- **Hide project / Unhide** live on a project's page (there is no per-project menu); Unhide also sits on each dimmed
  row of the Projects list while Show hidden projects is on.
- **`GET /api/projects` returns hidden projects too**, marked, so the Projects page can show them under "Show hidden
  projects". Everything else filters them out on the web side with one shared selector (visible projects) so the
  sidebar, board cards, New chat picker and onboarding counts can't drift apart. History is never deleted.
- **One "is this chat visible" rule** on the web: a chat (board or history) is hidden when its project is hidden. The
  board, Recent chats, All chats, provider counts and onboarding counts all use it.
- **Recent chats selector** replaces the grouped-by-project one: a flat list of the 10 most recent non-pinned,
  non-archived, non-snoozed chats (board and history-only), newest first, after filters and provider focus. The
  "N more" / "All projects" rows and the per-project "+" go away.
- **Recent chats row** (prototype variant A): one line, the existing row height; provider logo, title, running /
  needs-you mark, then the project label muted, right-aligned, capped at about 40% of the row and truncated. On hover
  the project label is replaced by the date. The row's accessible description carries project and date.
- **All chats view**: a new main-area view with its own route (`#/chats`) and a nav entry next to Board and Projects.
  A plain list (not a table): status, provider logo, title, project glyph + name, date. Search matches title and
  project name and highlights the match. A Filter button opens the existing filter menu limited to Project and
  Provider; active filters show as the existing filter chips. All chats has its own filter state, separate from the
  board's. The sidebar search icon navigates here and focuses the search box.
- **Older**: a project is Older when its last activity is more than 30 days before now. The New chat picker lists
  recent projects, then one "Older (n)" row that unfolds in place with older projects dimmed; typing in the picker
  search opens it. The Project filter menu (board and All chats) lists older projects after a separator under
  "Older · no activity in 30 days". The sidebar has no Older group (it no longer groups by project).
- **Projects page**: sorted by last activity by default (other sorts stay). A "Show hidden projects" switch at the top;
  when on, hidden projects show dimmed with **Unhide**. Each project's menu gets **Hide project**. Folder-missing
  projects show a "Folder missing" note and their chats stay readable.
- **New chat picker** leaves out hidden and folder-missing projects. Claude scratch chats is left out too, because it
  is many folders, not one (assumed; not grilled).
- **Naming** comes from one place (the server's project name, else the folder's last part), so every surface shows
  the same label.

## Testing Decisions

- Good tests here check what the user sees or what the API returns, not selector internals: render the app with a
  seeded store and assert on rows, labels and order; call the HTTP API and assert on the JSON.
- **Seam 1, server HTTP API** (prior art: `api.test.ts`, `projects.test.ts`, `settings.test.ts`):
  - `GET /api/projects` marks a temp-folder project `hidden: 'auto'`, a hand-hidden one `hidden: 'manual'`, a missing
    folder `folderMissing: true`, and returns several Claude scratch folders as one "Claude scratch chats" project.
  - `PATCH /api/settings` with `hiddenProjects` stores it, rejects non-string lists without writing, broadcasts
    `settings.updated`, and survives a restart of the settings store.
- **Seam 2, rendered web app** (prior art: `shell.test.tsx`, `filters.test.tsx`, `newchat.test.tsx`):
  - Recent chats shows the 10 newest non-pinned chats with project labels; hover/description shows the date; All chats
    link and search icon go to All chats (search focused).
  - All chats lists board and history chats, search and Project/Provider filters narrow it, chips remove filters, empty
    state shows.
  - Hidden projects disappear from sidebar, board, picker and onboarding counts; Show hidden + Unhide on Projects
    brings one back.
  - Picker: Older row with count, unfolds, search opens it; folder-missing projects absent.
  - The existing "1 000 history chats renders within budget" test keeps passing for Recent chats and is repeated for
    All chats.

## Out of Scope

- Deleting provider history or folders.
- Pinning or reordering projects.
- Renaming projects or Claude scratch chats.
- Table layout, sortable columns, day grouping or a facet rail in All chats (prototype variants B and C, rejected).
- Search inside chat messages (All chats searches titles and project names only).
- Changes to the board itself beyond leaving hidden projects' chats out.

## Further Notes

- Prototype: branch `prototype/projects-chats-redesign`, `design/prototype-projects-chats.html?v=a`.
- Watch at narrow sidebar widths: titles get short once the project label takes its share; the 40% cap is the lever.
- After this ships, update the onboarding copy that counts "chats from N projects" to use visible projects only.

## Progress

- [x] Slice 1: server marks hidden (auto/manual) and folder-missing projects, groups Claude scratch chats; `hiddenProjects` setting with PATCH + broadcast (API tests)
- [x] Slice 2: web hides hidden projects everywhere (sidebar, board, picker, onboarding counts) via one visible-projects selector
- [x] Slice 3: Projects page sorted by last activity, Show hidden projects switch, Hide project / Unhide, Folder missing note
- [ ] Slice 4: Recent chats as a flat list of 10 (variant A rows, date on hover, All chats link)
- [ ] Slice 5: All chats view: route, nav entry, list, search with highlight, Project/Provider filter menu + chips, sidebar search icon
- [ ] Slice 6: New chat picker: Older (n) row, search opens it, folder-missing and scratch left out; Project filter menu by project (hidden left out, scratch as one, Older label)
- [ ] Slice 7: glossary and README check, close #11

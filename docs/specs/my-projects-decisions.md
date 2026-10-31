# My projects and global search: decisions

Grilled 2026-10-31 for #38 (feedback items 1, 5 and 7 in `docs/research/2026-10-31-feedback-and-feasibility.md`).
Terms are in `GLOSSARY.md`.

**Problem:** the user has about 60 projects but works in 3–10 of them. Recent chats fills up with one-off and abandoned projects, and finding a chat means searching.

## Decisions

1. **My projects is a sidebar shortlist only.** A project left out still appears on the board, in All chats, the New chat picker and the Projects page. Hidden project stays separate and stronger (hidden everywhere).
2. **Sidebar order:** Providers → Pinned → My projects. Each project shows its name and then its 3 newest chats, then "N more", which opens All chats filtered to that project. The flat Recent chats list is removed.
3. **Which chats show:** the 3 newest by activity, leaving out pinned and archived chats; history chats are included. A running or needs-you chat always shows, even when it isn't among the newest 3.
4. **Project order:** by last activity. Dragging into your own order comes later.
5. **Onboarding:** a new step after "Chats found" lists projects by last activity.
   - Projects active in the last 14 days are pre-ticked, at most 5.
   - The rest sit behind "Older (n)"; a search box filters the list.
   - Skip keeps the pre-ticked projects.
6. **Auto-add:** starting a chat from our app in a project that isn't in My projects adds it. Activity outside the app doesn't add it; a "New activity in X · Add" hint shows instead.
7. **Changing it later:**
   - An add/remove star on Projects page rows and on a project's page.
   - "Remove from My projects" when hovering a project in the sidebar.
   - An Edit button on the section header reopens the picker.
8. **Users who already finished onboarding** (anyone who hasn't picked yet) get a one-time "Pick your projects" card at the top of the sidebar. Replay onboarding also shows the step.
9. **Global search:**
   - It replaces the sidebar's New chat button. The top-bar New chat stays, and `N` still opens it.
   - Typing opens a dropdown in two groups: **Projects**, where a match folds out its chats, and **Chats**, which match by title and show their project label.
   - Enter opens the result. `Ctrl+K` focuses the field. "See all results" opens All chats with the query.
   - It searches titles and project names only, not message text.
10. **Empty state:** "Pick the projects you work on" with a Pick button. There's no fallback to recent chats.
11. **Hidden wins:** a hidden project leaves the sidebar. Unhiding it brings it back into My projects.
12. **Folder missing:** the project stays in the sidebar, dimmed, with the note on hover; its chats still open.
13. **Claude scratch chats** can be picked as one project. Temp-folder projects never appear in the picker.
14. **Badges:** a project row shows a running dot and a count of needs-you + review chats.
15. **Collapsing:** each sidebar project can collapse to its name row. This is remembered per project on this device (browser storage).
16. **Design: prototype verdict, variant B "Cards + palette"** (2026-10-31; the prototype is on branch `prototype/my-projects`, `design/prototype-my-projects.html?v=b`). Variants A (a tree with a dropdown) and C (a one-project-open rail with search shown in place) were rejected.
   - **Sidebar project block:** each project in My projects is a small card.
     - The header has the project glyph, the name, and one summary line: running · N need you · last active.
     - The body lists its chats, then "N more in All chats".
     - Clicking the header collapses the card (decision 15).
     - The summary line replaces the separate badges in decision 14.
   - **Global search is a palette, not a dropdown** (this refines decision 9). Typing in the sidebar field, or pressing `Ctrl+K`, opens a wide palette centred over a dimmed page:
     - The left column lists matching projects.
     - The right column lists matching chats, or, when a project is highlighted, that project's chats.
     - "See all results in All chats" sits at the bottom, and Esc closes the palette.
   - **Onboarding pick step:** a grid of project tiles (glyph, name, chat count with last active, provider logos, a check in the corner), with search above it and "Older · no activity in 30 days (n)" below it.

## Implementation notes (not grilled; obvious defaults)

- A server setting `myProjects: string[] | null` holds folder paths. It uses `PATCH /api/settings` and the `settings.updated` broadcast, like `hiddenProjects`. `null` means the user hasn't picked yet, which is what shows the card in decision 8.
- Projects are compared with the shared folder key (`folderKey(projectFolder(...))`).

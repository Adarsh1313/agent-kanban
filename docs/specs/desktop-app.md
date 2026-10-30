# Spec: Agent Kanban desktop app (Plan 4, #20)

Date: 2026-10-30. Decisions come from the Plan 4 grilling and the desktop design grill. Background:
`docs/backlog.md` (section 1), `docs/adr/0001-electron-desktop-shell.md`, `design/DESIGN.md` (Desktop app
section, showcase in `design/design-system.html`), terms in `GLOSSARY.md`.

## Problem Statement

Agent Kanban is meant for people who are not necessarily technical, but today it only runs from a
terminal: you need Node, the repo, `npm run desktop`, and a pair of desktop shortcuts that open it in a
browser tab with Node's icon. Closing the tab doesn't stop the server, the "Stop" shortcut is the only
clean way out, and there's no way to see that a chat needs you once the tab is buried. It doesn't feel
like an app, and it can't be handed to anyone else.

## Solution

An installed **desktop app** called Agent Kanban, Windows first. It installs per user without admin
rights, ships its own runtime so nobody installs Node for it, and opens in its own window with its own
icon. Closing the window keeps it running in the **tray**, so chats carry on and notifications still
arrive; the tray icon shows an amber dot when a chat needs you and lists those chats. **Quit** stops
everything, asking first if chats are running. Opening it again focuses the window that's already
there. A chat's project folder can be opened in the file manager. **Browser mode** (`npm start`) stays
for development, using the same data.

## User Stories

1. As a user, I want to install Agent Kanban from one installer file, so that I don't need a terminal, Git or Node.
2. As a user without admin rights, I want the installer to install just for me, so that I don't need to ask anyone for a password.
3. As a user, I want Agent Kanban in the Start menu with its own icon, so that I can find and launch it like any other app.
4. As a user, I want to uninstall it from Windows' Apps settings, so that removing it is as normal as installing it.
5. As a user, I want my chats, projects and settings to survive uninstalling and reinstalling, so that updating by reinstalling loses nothing.
6. As a user, I want the app to open in its own window, so that it doesn't get lost among browser tabs.
7. As a user, I want the window to appear only once the board is ready, so that I never see a white flash or a half-drawn page.
8. As a user, I want the window to reopen at the size and place I left it, so that I don't rearrange it every time.
9. As a user who unplugged a monitor, I want the window to come back on a screen I can see, so that it never opens off-screen.
10. As a user, I want the window's top bar to be the title bar, with the sidebar colour running to the top edge, so that the app looks like one piece and not a web page in a frame.
11. As a user, I want to drag the window by the empty part of the top bar, so that moving it works like any other app.
12. As a user, I want Windows' own minimise, maximise and close buttons, so that window controls behave exactly as I expect.
13. As a user who switches between light and dark mode, I want the title bar buttons to match the app's theme, so that they stay visible and look right.
14. As a user, I want closing the window to keep Agent Kanban running in the tray, so that agents keep working while the window is out of the way.
15. As a user closing the window for the first time, I want a one-time note saying it's still running and how to quit, so that I'm not confused about where it went.
16. As a user, I want that note only once, so that it doesn't nag me every time.
17. As a user, I want the tray icon to show an amber dot when a chat needs me, so that I notice without opening the window.
18. As a user, I want the tray icon to match my taskbar (light or dark), so that it's always readable.
19. As a user, I want the tray menu to list up to three chats that need me, by title, so that I can jump straight to one.
20. As a user with more than three chats waiting, I want a "+N more" hint, so that I know there are others.
21. As a user, I want clicking a chat in the tray menu to open the window on that chat, so that I can answer it right away.
22. As a user, I want "Open Agent Kanban" in the tray menu, so that I can bring the window back.
23. As a user, I want clicking the tray icon to bring the window back, so that the common case takes one click.
24. As a user, I want "Start at login" in the tray menu, off by default, so that it starts with Windows only if I choose.
25. As a user, I want "Quit Agent Kanban" in the tray menu, so that I can stop it completely.
26. As a user quitting while chats are running, I want to be told how many will stop and asked to confirm, so that I don't kill work by accident.
27. As a user quitting with nothing running, I want it to quit straight away, so that I'm not asked pointless questions.
28. As a user, I want Quit to stop the agents cleanly, so that no helper processes are left behind.
29. As a user opening Agent Kanban while it's already running, I want the existing window brought forward, so that I never get two copies fighting over my chats.
30. As a user, I want a desktop notification when a chat needs me or finishes, even when the window is hidden, so that I don't have to keep checking.
31. As a user, I want clicking a notification to bring the window forward and open that chat, so that I can act on it immediately.
32. As a user, I want notifications to carry Agent Kanban's name and icon, so that I know where they came from.
33. As a user, I want "Open folder" on a chat, so that I can see its project's files in File Explorer.
34. As a user in browser mode, I want "Open folder" to work too, so that the two ways of running it behave the same.
35. As a user whose project folder was moved or deleted, I want a plain message saying the folder isn't there, so that I know why nothing opened.
36. As a user whose app couldn't start because browser mode is already running, I want a plain message saying so and what to do, so that I can fix it without a terminal.
37. As a user whose app couldn't start for another reason, I want "Agent Kanban couldn't start" with one plain line and Try again / Quit, so that I'm never stuck on a blank window.
38. As a user, I want Try again to really retry, so that a passing problem doesn't mean restarting Windows.
39. As a user, I want sign-in links for Claude Code, Codex and Antigravity to open in my normal browser, so that I sign in where I'm already logged in.
40. As a user, I want links in agent replies to open in my normal browser, not inside the app window, so that the app never turns into a browser.
41. As a user, I want the app to keep working the same after Windows sleeps and wakes, so that long-running chats aren't lost.
42. As a user, I want the app not to need an internet connection to open, so that it starts even offline (providers may still need it).
43. As the developer, I want `npm start` and the web dev server to keep working, so that I can develop without packaging.
44. As the developer, I want the desktop app and browser mode to share one data folder, with only one running at a time, so that they never disagree about my chats.
45. As the developer, I want one command that builds the installer, so that making a release is repeatable.
46. As the developer, I want the old launcher scripts and the two "Agent Kanban" / "Stop Agent Kanban" shortcuts removed, so that there's only one way to run the app.
47. As the developer, I want the server to tell the app when it's ready and why it failed, rather than the app parsing console text, so that startup is reliable.
48. As the developer, I want the session token to go straight from the server to the window and never be printed or written to a file, so that local security stays as it is.
49. As the developer, I want the desktop app's decisions (tray menu, Quit, first-close note, window placement) testable without Electron, so that `npm test` covers them.
50. As the developer, I want the app's icons generated from the SVGs in `design/assets/`, so that the design files stay the source of truth.

## Implementation Decisions

- **Shell (ADR 0001):** a new Electron workspace for the desktop app, next to the server, web and shared
  workspaces. Electron 45. Its main process owns the window, tray, single-instance lock, login item,
  native dialogs and the server child process. It contains no chat logic.
- **Feasibility first:** before anything else, prove the server runs on Electron's own Node (run as Node,
  e.g. `ELECTRON_RUN_AS_NODE` or a utility process): `node:sqlite`, TypeScript type stripping, the
  Claude Agent SDK, spawning provider binaries. If it can't, the fallback is shipping a separate Node
  binary inside the app to run the server (still no Node install for users). Record the outcome in
  ADR 0001.
- **Server desktop mode:** the server keeps running from its TypeScript sources, as today. When started
  by the desktop app it gets a random free port (port 0) and talks to its parent over an IPC channel:
  - server → app: `ready` with port and token; `failed` with a reason (`locked` = another Agent Kanban,
    usually browser mode, holds the data folder; `other` with a plain message). No console parsing.
  - app → server: `stop`, which runs the existing graceful shutdown (ends chats, disposes adapters,
    cancels installs). This replaces signals, which on Windows kill the child outright.
  - If the IPC channel closes (app crashed), the server shuts down too, so no orphan servers.
  - The `AGENT_KANBAN_OPEN_BROWSER` path and the stdout URL stay for browser mode.
- **Token handoff:** the app loads the window at the server's URL with `?token=`; the web client already
  strips it from the address bar and keeps it in session storage. The token is never logged by the app.
- **Window:** hidden until the board's first render, background from `--color-bg` for the current theme.
  Size and position saved in the data folder on move/resize and restored on launch, clamped onto a
  visible display. Navigation inside the window is limited to the server's origin; every other link
  (sign-in URLs, links in replies) opens in the default browser.
- **Title bar:** Electron's hidden title bar with a Windows title bar overlay at `--titlebar-height`. The
  web app's top bar becomes the drag region (interactive controls stay clickable) and reserves space
  for the caption buttons. Overlay colour and `--titlebar-symbol` follow the app's light/dark theme and
  update when it changes.
- **Desktop bridge:** a preload script exposes a small, typed bridge to the web app only inside the
  desktop app (its type lives in the shared package). Web app → app: `status` (needs-you chats as
  id + title, running count), `show`, `theme`. App → web app: `openChat(id)`. In browser mode the bridge
  is absent and the web app behaves as today. Context isolation on, no Node in the renderer.
- **Status source:** the web app already holds every chat's column; it sends `status` whenever the
  needs-you list or running count changes. The renderer keeps running while the window is hidden
  (background throttling off for this window), so the tray stays current.
- **Tray:** a single-colour tray icon (variant chosen from the taskbar theme) with the amber dot when the
  needs-you list is non-empty. Native menu: Open Agent Kanban · "Needs you" label + up to 3 chat titles
  (+N more) · separator · Start at login (checkbox) · Quit Agent Kanban. Left-click on the icon shows
  the window. Menu content is built by a pure function from `status` + login-item state.
- **Close and Quit:** closing the window hides it. On the first close ever (flag in the data folder), a
  Windows notification: "Agent Kanban is still running. Quit it from the tray icon." Quit with running
  chats shows a native message box: "N chats are running. Quitting stops them." with **Quit and stop
  chats** / **Cancel**; with none it quits at once. Quitting sends `stop`, waits for the server to exit
  (bounded wait, then kill), then exits. The decision (ask or not, wording with the count) is a pure
  function.
- **Second launch:** Electron's single-instance lock; the second launch exits and the first shows and
  focuses its window. The server's own data-folder lock stays as the guard against browser mode.
- **Start at login:** Windows login item, off by default, toggled only from the tray menu (an entry in
  the sidebar Settings menu is an open question in `design/DESIGN.md`).
- **Notifications:** the web app keeps using its existing notifier. Inside the desktop app it doesn't ask
  for browser permission, and a notification click calls `show` and opens that chat. The app sets its
  Windows app user model id so notifications carry the Agent Kanban name and icon.
- **Startup failure:** a local error page bundled with the desktop app (not served by the server), styled
  from `design/tokens.css`: "Agent Kanban couldn't start" + one plain line by reason (`locked`: another
  copy of Agent Kanban, maybe in a browser tab, is using your chats; close it and try again), **Try
  again** (restarts the server) and **Quit**.
- **Open folder (#15, first half):** a server endpoint that opens a folder in the system file manager,
  accepted only for a project folder the server already knows (from chats or history), returning a
  plain error if the folder no longer exists. The file-manager launcher is injected (like the folder
  picker). The chat actions menu gets "Open folder" next to "Copy project path", in both modes.
- **Icons:** Windows icon (.ico, several sizes), tray PNGs (light and dark taskbar, with and without the
  dot, 16/20/24/32) generated by a script from `design/assets/app-icon.svg` and `tray-icon.svg`, and
  committed. Colours stay as in `design/tokens.css`.
- **Packaging:** electron-builder, NSIS, per-user (no admin), unsigned, Windows x64. One npm script builds
  the web app and the installer. The package contains the desktop main + preload, the server sources and
  its runtime dependencies, the shared package, the built web app and the icons. App name "Agent
  Kanban". The data folder stays `~/.agent-kanban`, untouched by install or uninstall.
- **Removing the launcher:** the desktop launcher scripts and their three npm scripts go, and the two
  desktop shortcuts are deleted on this machine. `npm start` and the dev servers stay. README updated.

## Testing Decisions

- Good tests check behaviour someone could observe (messages sent, menu items shown, HTTP responses, what
  the user sees), not internals. Electron is never loaded in tests: its calls sit behind small injected
  interfaces.
- **Seam 1, server as a child process:** start the server in desktop mode as a child with an IPC channel
  and a temporary data folder. Assert `ready` arrives with a port that answers with the token;
  `failed: locked` when the lock is held; a `stop` message ends it with exit code 0; closing the channel
  ends it. Prior art: the e2e harness's stdin shutdown, `lock.test`, `stop-request.test`.
- **Seam 2, server API:** "open folder" accepts a known project folder and calls the injected launcher
  once; rejects unknown paths without calling it; returns the plain "isn't there" error for a missing
  folder; requires the token. Prior art: `api.test`, `folder-picker.test`.
- **Seam 3, desktop decisions as plain modules** (run by `node --test` with the server tests): tray menu
  model from status (0, 1, 3, 5 needs-you chats, long titles, login on/off, dot on/off); Quit decision
  and wording (0, 1, 2 running); first-close note shown once across restarts; saved window placement
  clamped to the available displays (monitor removed, size larger than the screen).
- **Seam 4, web app with a stubbed bridge** (vitest): `status` is sent when a chat enters or leaves Needs
  you and when the running count changes, not on unrelated updates; a notification click calls `show`
  and opens the chat; `openChat` from the app opens it; the top bar gets its title-bar layout only when
  the bridge exists; "Open folder" calls the endpoint and toasts the error. Prior art: `notify.test`,
  `connections.test`, `app-events.test`.
- **Manual checklist** (run on the installed app, in the slice that builds it): installs without admin;
  Start menu entry and icon; no white flash; title bar and caption buttons in light and dark; tray icon
  on light and dark taskbars, with the dot; tray menu actions; first-close note once; Quit with and
  without running chats leaves no `claude`/`codex`/`agy`/server processes; second launch focuses;
  Start at login survives a sign-out; notification click opens the chat; browser mode running → the
  `locked` error, Try again works after stopping it; uninstall keeps `~/.agent-kanban`.

## Out of Scope

- Mac build and signing (#25). Linux.
- Installing Claude Code and Codex without npm (#26).
- Auto-update, or an in-app "new version" check (comes when the repo goes public).
- Code signing for Windows (SmartScreen warning accepted for now).
- Open in app (#15, second half): opening a chat in its provider's own app.
- A Settings page; Start at login lives in the tray menu only.
- Hosted web app (#18, closed).
- Custom window, tray or dialog animation: native parts use the OS's own behaviour.

## Further Notes

- `design/DESIGN.md` (Desktop app section) and the Desktop section of `design/design-system.html` are the
  visual reference for the tray, title bar, first-close note, Quit box and failed-start screen.
- Electron's main process mirrors `design/tokens.css` values (window background, title bar colours);
  change the token first, then the mirror.
- If the feasibility slice needs the bundled-Node fallback, the server's child-process seam is the same,
  only the executable changes.
- Close #20 when the Progress list is done; move #15 to "Open in app" only.

## Progress

- [x] 1. Feasibility: server runs on Electron 45's Node (`node:sqlite`, type stripping, Agent SDK, spawning providers); outcome recorded in ADR 0001
- [x] 2. Server desktop mode: random port, IPC `ready` / `failed` / `stop`, exits when the channel closes (seam 1)
- [x] 3. Desktop workspace: single instance, starts the server, window hidden until ready, token handoff, external links to the browser, window placement saved and clamped (seam 3)
- [x] 4. Startup failure page with Try again / Quit, `locked` and `other` reasons
- [ ] 5. Desktop bridge + web status reporting; tray icon with needs-you dot and tray menu; close to tray with first-close note; Quit confirmation and clean stop; Start at login (seams 3 and 4)
- [ ] 6. Title bar overlay: top bar as drag region, caption buttons, theme sync (seam 4)
- [ ] 7. Notifications: app user model id, click shows the window and opens the chat (seam 4)
- [ ] 8. Open folder: server endpoint + chat actions menu item, both modes (seams 2 and 4)
- [ ] 9. Icons generated from the SVGs; electron-builder NSIS per-user installer; manual checklist passed on the installed app
- [ ] 10. Remove the launcher scripts, npm scripts and desktop shortcuts; README and backlog updated; #20 closed, #15 narrowed to Open in app

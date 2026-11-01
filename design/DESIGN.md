# Agent Kanban: design system ("Quiet Instrument")

Values live in `tokens.css`; the live showcase is `design-system.html`. Change a token there first.

## What this is

A local desktop app where every AI coding chat (Claude Code, Codex, Antigravity) is a card on a Kanban
board, for people who are not necessarily technical. Mode: **operate**. People come many times a day
to get work done and keep an eye on agents, so clarity and speed beat decoration.

## Direction

**Quiet Instrument:** restraint, closest to Linear. Warm-grey neutrals carry the layout; the only colour
is agent state and provider logos. If something is coloured, it is telling you something.

## Signature element

**The travelling card:** a chat's card moves between columns on its own (FLIP, `--duration-move`,
`--ease-in-out`, lifted to `--lift-scale`, column counts tick). The app icon is the same idea frozen:
one running-blue card halfway between two ink columns.

## Colour

- Light and dark, following the OS. Neutrals are warm grey; **ink** means selected / primary.
- State colours only for state: running blue, needs-you amber, review teal, done grey, danger red.
  Numbers or words always sit next to a colour, so colour is never the only signal.
- **Needs-you amber is one signal everywhere:** the card badge, the bell count, the tray dot.
- No purple, no gradients, no accent on decoration.

## Component conventions

- **One primary (ink) button per view.** On the board that is New chat.
- **Cards** carry title, provider logo + model, folder, time. Needs-you adds one reason badge; running
  adds the activity line. Detail lives in the side panel, never a new page.
- **Card actions appear on hover/focus.** Undoable actions (Stop, Archive) never confirm; Archive shows
  an Undo toast. Only the user moves cards to Done; drops on agent-owned columns snap back with a toast.
- **Shadows only for floating things** (dragged card, menus, panel, dialog). Cards use a border.
- **Radius by role:** badge 4, control 6, card 8, panel 12.
- **Mono only for file names and commands** inside agent activity.
- **Selected sidebar item** is a sliding neutral capsule, never a coloured left border.
- **Provider logos** from `assets/providers/` (LobeHub, MIT), colour versions, never recoloured.
- **Sidebar:** Board · All chats · Projects · Connections, then Providers (focus toggle), Pinned, Recent chats
  (the 10 newest chats, one line each: provider logo, title, the project muted on the right, swapped for
  the date on hover or focus), then an "All chats" link. The search icon opens All chats, search focused. 248px.
- **Focusing a provider** filters the board, adds a "Provider is X" chip, and swaps the top-bar usage
  for that provider's meters plus "Usage for all providers".
- **Filters** follow Linear: categories, then an options pane; active filters become chips; F opens it.
- **New chat** is project-first; providers that haven't worked there show disabled with the reason. Its
  project list has a search and folds projects idle for 30 days behind one "Older (n)" row (unfolds in
  place, dimmed; typing searches them too). Missing folders and Claude scratch chats aren't offered.
- **All chats:** a plain list (status, provider logo, title, project glyph and name, when), search that
  marks the match, and its own Filter limited to Project and Provider. 100 rows, then "Show 100 more".
- **Notifications** sit behind a bell (count, one damped ring per event, optional chime).
- **Projects:** Linear-style rows (providers with chat counts, a status bar of chats, last activity);
  detail shows providers that know the project, its chats, and an About column. Hidden projects (temp
  folder, or Hide project) are left out everywhere; "Show hidden projects" lists them dimmed with Unhide.
  A moved or deleted folder says "Folder missing": chats readable, New chat disabled.
- **Connections:** one card per agent, every state a dot and a word: Not installed → Installing →
  Signed out → Waiting for sign-in → Connected. Sign out asks first and says what stops working.
- **Onboarding:** full screen, Welcome + 4 counted steps (Connect, Bring in your chats, Notifications,
  Ready), 4-segment progress bar.
- **Empty board:** dimmed columns with dashed placeholders, a card explaining what happens, Start a
  chat / Browse projects, and the 3 most recent chats to pick up.
- **Routines:** Projects-style rows: name, project and provider, schedule in words ("Weekdays at
  8:00 am"), Next and Last captions, then Pause/Resume, Run now, Edit, Delete (asks first, keeps the
  chats). Paused rows dim. "Skipped, still running" and "Folder missing" use the needs text colour.
  The editor is a dialog: two-column labelled fields, Repeat as a segmented radio group (Daily,
  Weekdays, Chosen days), days as round toggles in a labelled group, a time input, a chime switch,
  and a note that routines run only while the app is open. A project's page lists its routines.

## Desktop app

The app (Electron, Windows first) mirrors these tokens in its main process; `tokens.css` stays the
source of truth. Native parts follow the OS; only what we draw uses our tokens.

- **App icon** (`assets/app-icon.svg`): `--icon-tile` rounded tile, three `--icon-ink` columns, one
  `--color-running` card halfway between two columns. Used for taskbar, Start menu, installer.
- **Tray icon** (`assets/tray-icon.svg`): the mark in one colour, `--tray-on-dark` or `--tray-on-light`
  to match the taskbar, plus a `--color-needs` dot when any chat needs you. No other states.
- **Tray menu** (native): Open Agent Kanban · up to 3 Needs-you chats by title (click opens that chat)
  and "+N more" · separator · Start at login ✓ · Quit Agent Kanban.
- **Title bar:** drawn by the app at `--titlebar-height`; the sidebar colour runs to the top edge and
  the top bar's empty space drags the window. Windows' own caption buttons stay, tinted with
  `--titlebar-symbol` on the matching background.
- **Closing the window** hides it to the tray. The first time only, a Windows notification:
  "Agent Kanban is still running. Quit it from the tray icon."
- **Quit with running chats:** native message box. "2 chats are running. Quitting stops them."
  Buttons: **Quit and stop chats** / **Cancel**. With nothing running, Quit is immediate.
- **Startup:** the window stays hidden until the board has rendered, on `--color-bg` (no white flash).
  A failed start shows a full-window error: "Agent Kanban couldn't start" plus one plain line on why
  and what to do (never the raw error), with **Try again** and **Quit**.

## Voice

- Plain words a non-developer understands: "Needs you", "Wants to run a command", "Stopped",
  "Resets 2:40 pm". Never "session", "turn", "thread id", "JSON-RPC", "Electron", "process".
- Short sentences, sentence case, no exclamation marks, no "seamlessly / powerful / boost".
- Say what happened and what to do next in one line: "You stopped the agent. Resume to let it carry
  on, or send a new instruction."
- Buttons are verbs naming the result: "Start chat", "Mark done", "Allow", "Quit and stop chats".

## Motion

Motion explains movement and state; it never decorates. my-motion and Emil's skills own motion. Full
table with values in `design-system.html`. Exits are faster than entrances; constant motion is linear.

| Moment | What moves | Token |
|---|---|---|
| Card changes column | card travels, lifts, counts tick | `--duration-move`, `--ease-in-out` |
| Button press | scales to 0.97 | `--duration-press`, `--press-scale` |
| Hover | colour tint only | `--duration-hover` |
| Activity step changes | text crossfades through 2px blur | `--duration-swap` |
| Running | sweep, linear loop | `--duration-sweep` |
| Menus, dropdowns | grow from their trigger | `--duration-pop`, `--ease-out` |
| Chat panel | slides in from the right | `--duration-panel`, `--ease-drawer` |
| Dialog | scale 0.96 → 1, centred | `--duration-dialog` |
| Page switch | 8px slide + fade, back reverses | `--duration-pop` |
| Onboarding step | 16px shared-axis slide | `--duration-move` |
| Any exit | faster than its entrance | `--duration-exit` |
| Desktop window, tray, native dialogs | nothing custom; the OS animates them | n/a |

Reduced motion: no travel, spin, sweep or scale; colour and opacity changes stay. CSS transitions for
anything interruptible; keyframes only for one-shot or looping effects.

## Anti-references

No purple or AI gradients, no terminal or developer aesthetic, no dense enterprise UI, no Electron
"web page in a frame" look (white flash on start, a grey Windows title bar above our own top bar).

## Anti-slop watchlist

- Pulsing "AI is thinking" dots. Use the sweep + a named step.
- Side-tab active border in the sidebar.
- A shadow on every card.
- Monospace creeping into labels and numbers.
- Every button the same weight.
- A full-colour tray icon, or tray states beyond the needs-you dot.
- Splash screens and loading spinners where a hidden-until-ready window would do.

## Open questions

- Per-message timestamps in the chat panel.
- Folder glyph colours should come from a small fixed palette in `tokens.css`.
- The sidebar already has a Settings menu: should Start at login also appear there, not only in the
  tray menu?
- Mac (#25): the tray icon becomes a menu bar template image; the title bar uses traffic lights.

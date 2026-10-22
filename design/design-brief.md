# Agent Kanban — Design Brief

## What this is

A local desktop app where every AI coding chat (Claude Code, Codex, Antigravity) is a card on a
Kanban board, for people who are not necessarily technical. Mode: **Operate**. People come here to get
work done and keep an eye on agents, many times a day, so clarity and speed beat decoration.

## Direction chosen: Quiet Instrument

Restraint, closest to Linear. Neutral warm-grey surfaces carry the layout; the only colour on the
board is agent state (running blue, needs-you amber, review teal, done grey) and the provider logos.
If something is coloured, it is telling you something.

Kept from the review: Linear's sidebar structure, provider logos instead of colour squares, the
Direction 2 activity line ("Editing signup.tsx" with a live sweep), usage chips with a dropdown that
breaks limits down by model, and Stop on running chats.

## Voice and tone

- Plain words a non-developer understands: "Needs you", "Wants to run a command", "Stopped",
  "Resets 2:40 pm". No "session", "turn", "thread id", "JSON-RPC".
- Short sentences, no exclamation marks, no "seamlessly / powerful / boost".
- Say what happened and what to do next in one line: "You stopped the agent. Resume to let it carry
  on, or send a new instruction."
- Buttons are verbs naming the result: "Start chat", "Mark done", "Resume", "Allow", "Archive chat".
- Numbers are always written next to any meter or colour so colour is never the only signal.

## Motion philosophy

Motion explains movement and state; it never decorates. Full table in `design-system.html`.

- **Signature moment:** a card travelling between columns (FLIP, 260ms `--ease-in-out`, lifted to
  1.02, column counts tick). This is what makes the board feel alive.
- **Always:** press feedback (scale 0.97), dropdowns that grow from their trigger, panel slide-in,
  activity text crossfading through a 2px blur, Show more with a 40ms stagger.
- **Never:** pulsing "thinking" dots, fade-up-on-scroll, bounce, motion on hover beyond a colour tint,
  animation that delays a keyboard action.
- Exits are faster than entrances (150ms out). Constant motion (the running sweep, the running icon)
  is linear.
- Reduced motion: no travel, spin, sweep or scale; colour and opacity changes stay.
- Use CSS transitions for anything that can be interrupted (cards, menus, toasts); keyframes only for
  one-shot or looping effects.

## Component conventions

- **One primary (ink) button per view.** On the board that is New chat.
- **Cards** carry: title, provider logo + model, folder, time. Needs-you cards add one reason badge.
  Running cards add the activity line. Nothing else on the card face; detail lives in the side panel.
- **Card actions appear on hover/focus** (Stop on running; Resume and Archive on stopped; Archive
  elsewhere). Destructive-feeling actions that can be undone (Stop, Archive) never ask for
  confirmation; Archive shows an Undo toast instead.
- **Only the user moves cards to Done** (button or drag). Dragging between agent-owned columns snaps
  back with an explanation toast.
- **Card detail opens in a side panel**, never a new page, so the board stays visible.
- **Shadows only for things that float** (dragged card, menus, panel, dialog). Cards use a border.
- **Radius by role:** badge 4, control 6, card 8, panel 12.
- **Mono type only for file names and commands** inside agent activity.
- **Selected sidebar item** uses a sliding neutral capsule, never a coloured left border.
- **Provider logos** come from `assets/providers/` (LobeHub icon set, MIT). Use the colour versions;
  never recolour them.

## Checklist coverage (Checklist Design)

| Checklist | Covered by |
|---|---|
| Kanban: columns, cards, drag and drop with drop target, quick add, detail on click, column counts, filtering | Board columns with state icons and counts; `+` on Running; Done highlights while dragging; side panel; provider filter |
| Chat: thread, multi-line input (Shift+Enter), sender identification, timestamps | Side panel thread with provider logo per agent message; composer hint. Timestamps per message: **to add** in the real app |
| Modal: title, clear actions, close, dimmed background | New chat dialog with "Start chat" / "Cancel", X, scrim |
| Toast: placement, variants, length, dismissable | Bottom centre, pauses on hover and hidden tab, 5s, Undo action |
| Loading: specific text, time threshold | Activity line names the actual step; Refresh shows "Checking…" |
| Empty state: specific heading, primary action, zero vs no-results | Column empty notes ("Nothing needs you"); Done drop hint. Whole-board first-run empty state: **designed with Connect next** |
| Onboarding / Integrations | Connect screen: **next deliverable** |

## Explicit anti-references

From the interview: no purple or AI gradients, no terminal or developer aesthetic, no dense enterprise
UI. Most tempting for this direction, and banned:

- Pulsing dot "AI is thinking" loader. Use the sweep + named step instead.
- Side-tab active border in the sidebar.
- Generic shadow on every card.
- Monospace creeping into labels and numbers.
- Every button looking the same weight.

## Revision 2 conventions

- **Sidebar:** Board · Projects · Connections, then Providers (a focus toggle), Pinned, and Recent chats
  grouped by project (Claude's layout) using each provider's own chat titles and logos.
- **Focusing a provider** filters the board, adds a "Provider is X" chip, and swaps the top-bar usage
  for that provider's 5-hour and weekly meters plus a "Usage for all providers" button.
- **Notifications** live behind a bell (count badge, one damped ring per new event, optional soft
  chime). Desktop notifications and sound each have a switch.
- **Filters** follow Linear: category list, then an options pane that slides in, with Select all / None;
  typing searches values across categories; active filters become chips with ×; F opens it.
- **New chat** is project-first; providers that haven't worked on that project are shown but disabled
  with the reason.
- **The chat panel** says "Same chat as in Claude Code" and offers "Open in Claude Code".

## Open questions / extend here

- Projects page, Connections page (room for free providers), Connect flow and first-run onboarding
  (3–5 steps) are not designed yet.
- Antigravity usage: if `agy` does not report limits, its chip shows "Limits unavailable" and it is
  never suggested. Design for that state exists in `design-system.html`.
- Per-message timestamps in the chat panel.
- Folder glyph colours are hard-coded sample values; the real app should derive them from a small
  fixed palette in `tokens.css`.

## Revision 3: Projects and Connections

- **Projects list** (Linear-style rows): project, who has worked on it (provider logos with chat
  counts), a status bar of its chats (working / needs you / to review / done / history only), last
  activity. Sort by name or last activity; search by name or path; "Add a folder".
- **Project detail**: "Providers that know this project" (one card each; providers that haven't worked
  there are shown dashed), the project's chats with a provider segmented filter, and an About column
  with location, stack, git branch and last commit, top folders, and which instruction file each
  provider reads (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) and whether it exists.
- **Connections**: one card per coding agent with a status dot and label. States: Not installed →
  Installing (progress bar, step text crossfades) → Signed out ("Installed. Sign in to finish.") →
  Waiting for sign-in (browser opened, updates on its own) → Connected (version, chats found, usage,
  switches for "Show its chats in Recent chats" and "Suggest it for new chats"). Failed sign-in shows
  what happened and "Try again". Sign out asks first and says what stops working.
- **More agents, coming later** (including free ones): OpenCode, Qwen Code, Cursor CLI, GitHub Copilot
  CLI with "Notify me", plus "Something else?" to request one. Free-tier claims must be checked
  before launch.
- Views switch with an 8px slide and fade (`--duration-pop`); going back slides the other way. The
  projects list staggers in only on first visit.

## Revision 4: onboarding, empty board, calmer sidebar

- **Recent chats, decluttered:** project names are plain muted labels (no glyph, no provider logos);
  each chat row has one icon, its provider's logo. Only the 4 most recently active projects show,
  sorted by activity, 3 chats each, then "All projects". Full titles on hover. Sidebar is 248px.
  Chats from agents that aren't connected, or that the user chose to hide, don't appear.
- **Onboarding** (full screen, 4 counted steps plus a welcome): Welcome (a tiny board where one card
  travels, showing the idea in 5 seconds) → Connect (detects each agent; Install / Sign in inline;
  needs at least one) → Bring in your chats (counts per agent, projects found, per-agent "Show in
  sidebar", a plain statement of what is read) → Notifications (sample notification, desktop and
  sound switches, "Play it") → Ready (summary, "Start your first chat" or "Go to the board").
  Steps slide 16px on a shared axis; Back reverses the direction. Progress is a 4-segment bar.
- **Empty board:** columns stay visible but dimmed with dashed placeholders; a card on top explains
  what happens ("shows up in Running, then moves across the board on its own"), offers Start a chat
  and Browse projects, and lists the 3 most recent chats from history to pick up. With no agent
  connected, it points to Connections instead.

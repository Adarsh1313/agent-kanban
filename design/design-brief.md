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

# Agent Kanban

A local app where every AI coding chat is a card on a Kanban board, run on each provider's own official tool.

## Language

### Core

**Provider**:
One of the AI coding tools the app drives through its official binary: Claude Code, Codex or Antigravity.
_Avoid_: Agent, model, harness

**Chat**:
One conversation with a provider in a project, shown as a card on the board.
_Avoid_: Session, thread, task

**Project**:
A folder on the user's computer that chats run in.
_Avoid_: Repo, workspace

**My projects**:
The projects the user picked as the ones they work on; the sidebar lists them, each with its newest chats. A project left out is still everywhere else.
_Avoid_: Favourite projects, starred projects, Recent chats (replaced)

**Global search**:
The sidebar's search field that finds projects and chats by name and opens them.
_Avoid_: Command palette, quick open

**All chats**:
The view listing every chat, on the board or only in a provider's history, searchable and filterable.
_Avoid_: Chat list, archive

**Hidden project**:
A project kept out of the sidebar, the board and New chat; one of the user's choosing or a folder in the computer's temp folder.
_Avoid_: Archived project, filtered project

**Claude scratch chats**:
The quick chats the Claude app starts without a folder, shown together as one project.
_Avoid_: Scratch workspaces, temp chats

**Older project**:
A project with no activity for 30 days: folded behind one "Older" row in New chat and listed last in the Project filter.
_Avoid_: Stale project, archived project

**Folder missing**:
A project whose folder was moved or deleted: its chats can be read but no new chat can start there.
_Avoid_: Broken project, stale project

### Running the app

**Desktop app**:
The installed Agent Kanban, with its own window and tray icon; the way users run it.
_Avoid_: Electron app, shell, launcher

**Browser mode**:
Running Agent Kanban from source (`npm start`) and using it in a browser tab; for development. Uses the same data as the desktop app, and only one of the two runs at a time.
_Avoid_: Web app, dev mode

**Tray**:
The Windows notification-area icon (menu bar on Mac) where the desktop app keeps running after its window is closed.
_Avoid_: Background mode, system tray app

**Quit**:
Stopping the desktop app and every running chat; closing the window is not quitting.
_Avoid_: Close, exit

### Working across providers and limits

**Outside session**:
A Claude Code chat the user runs in a terminal or the Claude app, not from Agent Kanban; it shows on the board through hooks and can be continued here once it stops.
_Avoid_: External session, foreign chat

**Home provider**:
The provider whose skills and global instructions are copied to the others; picked in onboarding.
_Avoid_: Main provider, primary agent

**Skill sync**:
The one-way copy of the home provider's skills and instructions into the other providers, each copy marked as managed by Agent Kanban.
_Avoid_: Skill import, skill mirror

**Handoff**:
Switching a chat to another provider mid-way; the new provider gets the last messages, the active spec's progress and the project notes.
_Avoid_: Agent switch, transfer

**Project notes**:
A notes file in a project that every provider reads and updates at the end of a task, so decisions travel between them.
_Avoid_: Memory, shared context

**Out of usage**:
A needs-you reason: the provider's plan limit is reached; the chat resumes on its own at the reset time unless turned off.
_Avoid_: Rate limited, Limited, quota exceeded

**Follow-up queue**:
Messages written while a chat is working or out of usage, sent in order when it can continue.
_Avoid_: Pending messages, outbox

**Account**:
One sign-in to a provider; a provider can have several and one is active at a time.
_Avoid_: Instance, profile, login

**API key**:
A provider key the user adds, used only when they choose it for a chat, billed per use and capped by an optional spend cap.
_Avoid_: Token, secret, credential

**Spend cap**:
An API key's optional monthly limit in dollars; when its spend reaches it, the key's chats stop with "Spend cap reached" (a needs-you reason). Spend starts again at 0 each month.
_Avoid_: Budget, quota, limit

**Effort**:
How long the agent should think: Quick, Normal or Thorough.
_Avoid_: Reasoning effort, thinking budget, Ultrathink

**Suggested next steps**:
Up to 3 follow-ups offered after a reply; clicking one fills the composer.
_Avoid_: Suggestions, quick replies

**Archived**:
Set aside from the board and the default All chats view, but kept and restorable with Unarchive; applies to history-only chats too.
_Avoid_: Hidden chat, closed chat

**Trash**:
Where deleted chats wait 30 days before they are gone for good; they can be restored from there.
_Avoid_: Recycle bin, deleted items

**Compare**:
Several project boards stacked one below another, up to 3 open at once; the rest are minimized to their header.
_Avoid_: Split view, multi-board

**Routine**:
A skill or prompt that runs in a project on a schedule while the app is open; each run is a new chat.
_Avoid_: Workflow, scheduled task, cron job

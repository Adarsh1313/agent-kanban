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

**Recent chats**:
The sidebar's list of the most recently active chats, newest first, each labelled with its project.
_Avoid_: History, threads

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

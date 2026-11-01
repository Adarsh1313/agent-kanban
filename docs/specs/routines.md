# Routines: run a skill or prompt on a schedule

Built from `docs/specs/routines-decisions.md` (grilled 2026-10-31). Terms are in `GLOSSARY.md`. Closes #45.

## Problem Statement

The user repeats the same requests, like a morning review or a weekly tidy-up, by hand. Nothing in the app can run a skill or prompt at a set time.

## Solution

A **Routines** page lists routines and has a plain editor. A routine has a name, a project, a provider (and effort), a skill or prompt, and a schedule: daily, weekdays, or chosen days at a time. While the app is open, each run starts a new chat, "Routine name · 31 Oct", which ends in Review. A run missed while the app was closed runs once on open if it was within the last 12 hours.

The editor follows T3 Code's scheduled tasks and Enjoy's workflows (weekday and time pickers, pause, run now), built from our existing form controls and list rows.

## User Stories

1. As a user, I want a Routines item in the sidebar, so that I can find my routines.
2. As a user, I want a list of routines showing name, project, schedule in words ("Weekdays at 8:00 am"), next run and last result, so that I know what will happen.
3. As a user, I want New routine to open an editor with name, project, provider, effort, skill or prompt, and schedule, so that setting one up is simple.
4. As a user, I want the skill field to offer my skills with `/`, so that I can run a skill on a schedule.
5. As a user, I want schedule choices Daily, Weekdays and Chosen days, plus a time, so that I don't need cron.
6. As a user, I want the provider to default to my home provider, so that it's one less choice.
7. As a user, I want Pause/Resume and Run now on each routine, so that I can control and test it.
8. As a user, I want each run to start a chat titled "Routine name · 31 Oct" that ends in Review, so that I check results like any chat.
9. As a user, I want an optional chime when a routine finishes, so that I notice.
10. As a user, I want a routine skipped (and marked "Skipped, still running") if the previous run is still going, so that runs don't pile up.
11. As a user, I want a run missed in the last 12 hours to run once when I open the app, marked "Ran late", so that I don't lose a day.
12. As a user, I want a note that routines only run while the app is open, so that my expectations are right.
13. As a user, I want a project's page to list its routines, so that I see them where they apply.
14. As a user, I want deleting a routine to ask first and keep the chats it made, so that results stay.
15. As a user, I want a routine whose project folder is missing paused with "Folder missing", so that it doesn't fail silently.
16. As a keyboard and screen reader user, I want the editor's controls labelled, and the day choices as a group of toggles.

## Implementation Decisions

- **Store:** a `routines` table: `{ id, name, cwd, provider, effort, kind: 'skill'|'prompt', text, schedule: { days: number[] (0–6), time: 'HH:MM' }, paused, lastRunAt, lastResult, chime }`. Daily is all 7 days; Weekdays is 1–5.
- **API:** `GET/POST /api/routines`, `PATCH/DELETE /api/routines/:id` and `POST /api/routines/:id/run`. Each change broadcasts `routines.updated`.
- **Scheduler** (server):
  - One timer for the next due run, using the machine's local time zone. It's re-armed on change, on start and at midnight.
  - At fire time it starts a chat through the normal new-chat path, with the routine's effort (from `composer.md`) and the skill in its provider form (from `cross-provider.md`; a plain prompt if that isn't built yet).
  - It skips the run if the routine's previous chat is still running.
  - On start it runs each routine whose last due time fell in the past 12 hours and hasn't run yet, marked late.
- **Chats** made by a routine store `routineId`, for the project page and the list's last result.
- **Web:**
  - the Routines page (Projects-style rows);
  - the editor in a dialog;
  - a small Routines block on the project page.
  - The schedule summary is formatted in plain words.

## Testing Decisions

- **Seam 1, server HTTP API** (prior art: `chats.test.ts`, `store.test.ts`), with a fake clock and a fake adapter:
  - CRUD and validation (time format, at least one day);
  - a run starts a chat with the title and effort;
  - Weekdays doesn't run on Saturday;
  - Pause stops runs;
  - Run now works;
  - an overlap is skipped;
  - a run missed within 12 h runs on start, and one missed past 12 h doesn't;
  - a missing folder pauses the routine.
- **Seam 2, rendered web app:**
  - the list shows the schedule in words and the next run;
  - the editor creates a routine;
  - Pause, Run now and Delete (with confirm) work;
  - the project page lists its routines.

## Out of Scope

- Cron expressions, intervals and webhooks.
- Running while the app is closed (Windows Task Scheduler).
- A gallery of ready-made routines.

## Further Notes

- Uses effort (#42) and skills (#40) when they exist. Without them it falls back to Normal effort and plain prompts, so it can ship on its own.
- DESIGN.md gains the Routines page and editor.

## Progress

- [x] Slice 1: routines store + CRUD API with validation and tests
- [x] Slice 2: scheduler: due runs, weekdays/days/time, pause, run now, overlap skip, 12 h catch-up, folder missing
- [x] Slice 3: web: Routines sidebar item, list with plain schedule and next run, editor dialog
- [ ] Slice 4: project page Routines block, chime option, skill picker; DESIGN.md; close #45

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The Claude Code events that move an outside chat on the board (#37). */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Our entries are found again by the script's file name, so removing never touches the user's own hooks. */
export const HOOK_SCRIPT_NAME = 'agent-kanban-hook.mjs';

/**
 * The script Claude Code runs for each event. It forwards the event (stdin) to the running app, whose port
 * and secret it reads from the endpoint file. It always exits 0 within about a second, so Claude Code is
 * never slowed down or failed, whether or not the app is open.
 */
export const HOOK_SCRIPT = `// Written by Agent Kanban. Shows the Claude Code chats you run outside the app on its board.
import { readFileSync } from 'node:fs';
import http from 'node:http';
const done = () => process.exit(0);
setTimeout(done, 1000);
let ep = null;
try { ep = JSON.parse(readFileSync(process.argv[2], 'utf8')); } catch { done(); }
if (!ep || !Number.isInteger(ep.port) || typeof ep.secret !== 'string') done();
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { body += c; if (body.length > 1000000) done(); });
process.stdin.on('error', done);
process.stdin.on('end', () => {
  const req = http.request({ host: '127.0.0.1', port: ep.port, path: '/api/hooks/claude/event', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Kanban-Hook': ep.secret } }, (res) => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.end(body);
});
`;

type HookEntry = { type?: string; command?: string; timeout?: number };
type HookGroup = { matcher?: string; hooks?: HookEntry[] };
type ClaudeSettings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

const ours = (e: HookEntry) => typeof e.command === 'string' && e.command.includes(HOOK_SCRIPT_NAME);

/** Adds and removes Agent Kanban's entries in Claude Code's settings.json, leaving everything else as it was. */
export class ClaudeHooks {
  private settingsPath: string;
  private scriptPath: string;
  private endpointPath: string;
  private runner: string;

  /** `runner` starts the script: a quoted node path, or an Electron path run as Node. */
  constructor(opts: { settingsPath: string; scriptPath: string; endpointPath: string; runner: string }) {
    this.settingsPath = opts.settingsPath;
    this.scriptPath = opts.scriptPath;
    this.endpointPath = opts.endpointPath;
    this.runner = opts.runner;
  }

  /** Forward slashes work for Node on Windows and need no escaping in the shell Claude Code runs hooks in. */
  command(): string {
    const slash = (p: string) => p.replace(/\\/g, '/');
    return `${this.runner} "${slash(this.scriptPath)}" "${slash(this.endpointPath)}"`;
  }

  installed(): boolean {
    const hooks = this.read()?.hooks;
    if (!hooks || typeof hooks !== 'object') return false;
    return HOOK_EVENTS.every((ev) => Array.isArray(hooks[ev]) && hooks[ev]!.some((g) => Array.isArray(g?.hooks) && g.hooks.some(ours)));
  }

  install(): void {
    mkdirSync(dirname(this.scriptPath), { recursive: true });
    writeFileSync(this.scriptPath, HOOK_SCRIPT);
    const s = this.withoutOurs(this.read() ?? {});
    const hooks = (s.hooks ??= {});
    for (const ev of HOOK_EVENTS) {
      (hooks[ev] ??= []).push({ matcher: '', hooks: [{ type: 'command', command: this.command(), timeout: 5 }] });
    }
    this.write(s);
  }

  remove(): void {
    const s = this.read();
    if (!s) return;
    this.write(this.withoutOurs(s));
  }

  /** A file we can't read as JSON is never rewritten: installing would lose the user's settings. */
  private read(): ClaudeSettings | null {
    let raw: string;
    try { raw = readFileSync(this.settingsPath, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    if (raw.trim() === '') return null;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error("Claude Code's settings file isn't in the expected format.");
    return v as ClaudeSettings;
  }

  private withoutOurs(s: ClaudeSettings): ClaudeSettings {
    if (!s.hooks || typeof s.hooks !== 'object') return s;
    for (const ev of Object.keys(s.hooks)) {
      const groups = s.hooks[ev];
      if (!Array.isArray(groups)) continue;
      const kept = groups
        .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((e) => !ours(e)) } : g))
        .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
      if (kept.length > 0) s.hooks[ev] = kept;
      else delete s.hooks[ev];
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
    return s;
  }

  private write(s: ClaudeSettings): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const tmp = `${this.settingsPath}.agent-kanban.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
    renameSync(tmp, this.settingsPath);
  }
}

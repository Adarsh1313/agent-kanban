import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ProviderId, SkillsReport } from '@agent-kanban/shared';
import { writeBlock } from './managed.ts';

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'antigravity'];
export const MARKER = '.agent-kanban-managed';

/** Where each provider keeps its skills and its global instructions, under `home`. */
export function providerPaths(home: string, id: ProviderId): { skills: string; instructions: string } {
  if (id === 'claude') return { skills: join(home, '.claude', 'skills'), instructions: join(home, '.claude', 'CLAUDE.md') };
  if (id === 'codex') return { skills: join(home, '.codex', 'skills'), instructions: join(home, '.codex', 'AGENTS.md') };
  return { skills: join(home, '.gemini', 'antigravity', 'skills'), instructions: join(home, '.gemini', 'GEMINI.md') };
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const list = (p: string) => { try { return readdirSync(p); } catch { return []; } };

/** Skill folders (holding SKILL.md) directly in `dir`. */
function skillDirs(dir: string): { name: string; path: string }[] {
  return list(dir).filter((n) => !n.startsWith('.') && existsSync(join(dir, n, 'SKILL.md'))).map((name) => ({ name, path: join(dir, name) }));
}

/** `skills` folders in the Claude plugin cache (marketplace/plugin/version/skills), searched a few levels deep. */
function pluginSkillRoots(dir: string, depth = 4): string[] {
  if (depth < 0) return [];
  const out: string[] = [];
  for (const n of list(dir)) {
    const p = join(dir, n);
    if (n.startsWith('.') || !isDir(p)) continue;
    if (n === 'skills') out.push(p);
    else out.push(...pluginSkillRoots(p, depth - 1));
  }
  return out;
}

/** The home provider's skills (its own first, then Claude plugin skills); a repeated name keeps the first. */
export function sourceSkills(home: string, homeProvider: ProviderId): { name: string; path: string }[] {
  const roots = [providerPaths(home, homeProvider).skills];
  if (homeProvider === 'claude') roots.push(...pluginSkillRoots(join(home, '.claude', 'plugins', 'cache')));
  const seen = new Map<string, string>();
  for (const r of roots) for (const s of skillDirs(r)) if (!seen.has(s.name)) seen.set(s.name, s.path);
  return [...seen].map(([name, path]) => ({ name, path }));
}

/** Folders whose changes should trigger a sync. */
export function sourceRoots(home: string, homeProvider: ProviderId): string[] {
  const p = providerPaths(home, homeProvider);
  const roots = [p.skills];
  if (homeProvider === 'claude') roots.push(join(home, '.claude', 'plugins', 'cache'));
  return roots;
}

function hashDir(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const n of list(d).sort()) {
      if (n === MARKER) continue;
      const p = join(d, n);
      if (isDir(p)) walk(p);
      else { h.update(relative(dir, p).replace(/\\/g, '/')); h.update('\0'); h.update(readFileSync(p)); h.update('\0'); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

function readMarker(dir: string): { source: string; hash: string } | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'));
    return m && typeof m.hash === 'string' ? m : null;
  } catch { return null; }
}

/**
 * Copies the home provider's skills and global instructions one way into the other providers. Copies carry a
 * marker; changed sources are recopied and removed ones deleted. An unmanaged folder with the same name is left
 * alone and reported. Only the managed block of an instruction file is touched.
 */
export function syncSkills(home: string, homeProvider: ProviderId): SkillsReport {
  const sources = sourceSkills(home, homeProvider);
  const hashes = new Map(sources.map((s) => [s.name, hashDir(s.path)]));
  const synced = new Set<string>();
  const skipped: SkillsReport['skipped'] = [];
  let instructions: string | null = null;
  try { instructions = readFileSync(providerPaths(home, homeProvider).instructions, 'utf8').trim() || null; } catch { /* none */ }

  for (const target of PROVIDERS.filter((p) => p !== homeProvider)) {
    const { skills: dir, instructions: instrFile } = providerPaths(home, target);
    for (const n of list(dir)) {
      const p = join(dir, n);
      if (!hashes.has(n) && isDir(p) && readMarker(p)) rmSync(p, { recursive: true, force: true });
    }
    for (const s of sources) {
      const dest = join(dir, s.name);
      const hash = hashes.get(s.name)!;
      if (existsSync(dest)) {
        const m = readMarker(dest);
        if (!m) { skipped.push({ name: s.name, provider: target }); continue; }
        if (m.hash === hash) { synced.add(s.name); continue; }
        rmSync(dest, { recursive: true, force: true });
      }
      mkdirSync(dir, { recursive: true });
      cpSync(s.path, dest, { recursive: true });
      writeFileSync(join(dest, MARKER), JSON.stringify({ source: s.path, hash }));
      synced.add(s.name);
    }
    writeBlock(instrFile, instructions);
  }
  return { synced: [...synced].sort(), skipped };
}

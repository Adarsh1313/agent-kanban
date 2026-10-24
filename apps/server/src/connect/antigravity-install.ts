// Downloads Google's pinned agy-acp-server release, checks its size and SHA-256 while it
// streams to disk, unpacks it into a temp folder and renames that into place. Anything
// half-done (the .partial archive, the temp folder) is deleted on failure or cancel.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, readdirSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createInflateRaw, crc32 } from 'node:zlib';
import { resolveAntigravityRelease } from './antigravity-release.ts';
import type { AntigravityRelease } from './antigravity-release.ts';

export const DOWNLOAD_FAILED = "The download didn't finish. Try again.";
export const UNSUPPORTED_PLATFORM = "Google doesn't publish Antigravity for this computer.";

export type InstallPhase = 'download' | 'verify' | 'extract';
export interface InstallProgress { phase: InstallPhase; fraction: number }
export interface InstalledAntigravity { path: string; version: string }

export interface InstallOptions {
  home: string;
  fetch?: typeof fetch;
  onProgress: (p: InstallProgress) => void;
  signal: AbortSignal;
  /** Overrides for tests; production uses the pinned table for this computer. */
  release?: AntigravityRelease;
  platform?: NodeJS.Platform;
}

interface PlatformOpts { platform?: NodeJS.Platform; arch?: string; release?: AntigravityRelease | null }

export function antigravityRoot(home: string): string {
  return join(home, '.agent-kanban', 'providers', 'antigravity');
}

function releaseFor(o: PlatformOpts): AntigravityRelease | null {
  if (o.release !== undefined) return o.release;
  return resolveAntigravityRelease(o.platform ?? process.platform, o.arch ?? process.arch);
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

const VERSION_DIR = /^\d+(\.\d+)*$/;
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The pinned version if it's installed, else the newest other installed version, else null. */
export function findInstalledAntigravity(home: string, opts: PlatformOpts = {}): InstalledAntigravity | null {
  const release = releaseFor(opts);
  if (!release) return null;
  const root = antigravityRoot(home);
  const pinned = join(root, release.version, release.executable);
  if (isFile(pinned)) return { path: pinned, version: release.version };
  let names: string[];
  try { names = readdirSync(root); } catch { return null; }
  const found = names
    .filter((n) => VERSION_DIR.test(n) && isFile(join(root, n, release.executable)))
    .sort(compareVersions);
  const best = found.at(-1);
  return best ? { path: join(root, best, release.executable), version: best } : null;
}

function abortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r;
  const e = new Error('The install was cancelled.');
  e.name = 'AbortError';
  return e;
}

/** Download, verify and unpack the pinned release. Resolves with the executable's path. */
export async function installAntigravity(opts: InstallOptions): Promise<InstalledAntigravity> {
  const platform = opts.platform ?? process.platform;
  const release = opts.release ?? resolveAntigravityRelease(platform, process.arch);
  if (!release) throw new Error(UNSUPPORTED_PLATFORM);
  const existing = findInstalledAntigravity(opts.home, { release });
  if (existing && existing.version === release.version) return existing;

  const { signal, onProgress } = opts;
  const root = antigravityRoot(opts.home);
  const dir = join(root, release.version);
  const partial = `${dir}.partial`;
  let temp: string | null = null;
  const cleanup = async () => {
    await rm(partial, { force: true }).catch(() => {});
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
  };

  try {
    signal.throwIfAborted();
    await mkdir(root, { recursive: true });
    // A version folder without its executable is a broken earlier install: start over.
    await rm(dir, { recursive: true, force: true });
    await cleanup();

    const digest = await download(opts.fetch ?? fetch, release, partial, signal, onProgress);

    onProgress({ phase: 'verify', fraction: 0 });
    if (digest !== release.sha256) throw new Error(DOWNLOAD_FAILED, { cause: new Error('SHA-256 mismatch') });
    onProgress({ phase: 'verify', fraction: 1 });

    signal.throwIfAborted();
    onProgress({ phase: 'extract', fraction: 0 });
    temp = await mkdtemp(`${dir}.extract-`);
    await extractArchive(partial, temp, platform, signal, (f) => onProgress({ phase: 'extract', fraction: f }));
    const exe = join(temp, release.executable);
    if (!isFile(exe)) throw new Error(DOWNLOAD_FAILED, { cause: new Error(`${release.executable} missing from the archive`) });
    if (platform !== 'win32') await makeExecutable(temp);
    signal.throwIfAborted();
    await rename(temp, dir);
    temp = null;
    await rm(partial, { force: true });
    onProgress({ phase: 'extract', fraction: 1 });
    return { path: join(dir, release.executable), version: release.version };
  } catch (err) {
    await cleanup();
    if (signal.aborted) throw abortError(signal);
    if (err instanceof Error && err.message === DOWNLOAD_FAILED) throw err;
    throw new Error(DOWNLOAD_FAILED, { cause: err });
  }
}

async function download(
  fetchImpl: typeof fetch,
  release: AntigravityRelease,
  partial: string,
  signal: AbortSignal,
  onProgress: (p: InstallProgress) => void,
): Promise<string> {
  onProgress({ phase: 'download', fraction: 0 });
  const res = await fetchImpl(release.url, { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  // fetch decodes gzip itself, so content-length only means the archive size for identity bodies.
  const encoding = res.headers.get('content-encoding')?.trim().toLowerCase();
  const length = res.headers.get('content-length');
  if ((!encoding || encoding === 'identity') && length !== null && Number(length) !== release.archiveBytes) {
    throw new Error('Download size does not match the pinned release');
  }
  const hash = createHash('sha256');
  const fh = await open(partial, 'w', 0o600);
  let bytes = 0;
  let reported = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > release.archiveBytes) throw new Error('Download is larger than the pinned release');
      hash.update(chunk);
      await fh.write(chunk);
      const f = bytes / release.archiveBytes;
      if (f - reported >= 0.01 || bytes === release.archiveBytes) {
        reported = f;
        onProgress({ phase: 'download', fraction: f });
      }
    }
  } finally {
    await fh.close();
  }
  if (bytes !== release.archiveBytes) throw new Error('Download ended early');
  return hash.digest('hex');
}

async function makeExecutable(folder: string): Promise<void> {
  for (const e of await readdir(folder, { withFileTypes: true })) {
    if (e.isFile()) await chmod(join(folder, e.name), 0o755);
  }
}

/**
 * Windows 10+ and macOS ship bsdtar, which reads zip archives. GNU tar on Linux can't, and
 * `unzip` isn't always installed, so Linux uses the small zip reader below.
 */
async function extractArchive(
  archive: string,
  dest: string,
  platform: NodeJS.Platform,
  signal: AbortSignal,
  onFraction: (f: number) => void,
): Promise<void> {
  if (platform === 'win32' || platform === 'darwin') {
    await runTar(systemTar(platform), ['-xf', archive, '-C', dest], signal);
  } else {
    await extractZip(archive, dest, signal, onFraction);
  }
}

function systemTar(platform: NodeJS.Platform): string {
  // Use the OS's own bsdtar by full path: Git for Windows puts GNU tar (no zip support) on PATH.
  if (platform === 'win32') return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return '/usr/bin/tar';
}

function runTar(cmd: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 4096) stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with ${code}: ${stderr.trim()}`));
    });
  });
}

// ---- Minimal zip reader (stored + deflate, no zip64, no encryption) ----

interface ZipEntry { name: string; method: number; crc: number; compSize: number; size: number; localOffset: number; mode: number; dir: boolean }

function safeEntryName(name: string): boolean {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  return name.split('/').every((seg, i, all) => seg !== '..' && seg !== '.' && (seg !== '' || i === all.length - 1));
}

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  if (bytesRead !== len) throw new Error('Zip archive is truncated');
  return buf;
}

async function readEntries(archive: string): Promise<ZipEntry[]> {
  const fh = await open(archive, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a zip archive');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('Zip64 archives are not supported');
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad zip central directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compSize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      const unixType = (external >>> 16) & 0o170000;
      const dir = name.endsWith('/');
      if (!safeEntryName(name)) throw new Error(`Unsafe zip entry: ${name}`);
      if (flags & 1) throw new Error('Encrypted zip entries are not supported');
      if (!dir && method !== 0 && method !== 8) throw new Error(`Unsupported zip compression ${method}`);
      if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) throw new Error(`Unsupported zip entry type: ${name}`);
      if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error('Zip64 archives are not supported');
      entries.push({ name, method, crc, compSize, size, localOffset, mode: (external >>> 16) & 0o777, dir });
    }
    // Resolve each entry's data offset from its local header.
    for (const e of entries) {
      const lh = await readAt(fh, e.localOffset, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('Bad zip local header');
      e.localOffset = e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Unpack a zip into dest, checking each member's size and CRC-32. */
export async function extractZip(archive: string, dest: string, signal: AbortSignal, onFraction: (f: number) => void = () => {}): Promise<void> {
  const entries = await readEntries(archive);
  const total = entries.reduce((s, e) => s + e.compSize, 0) || 1;
  let done = 0;
  for (const e of entries) {
    signal.throwIfAborted();
    const target = join(dest, ...e.name.split('/').filter(Boolean));
    if (e.dir) { await mkdir(target, { recursive: true }); continue; }
    await mkdir(dirname(target), { recursive: true });
    let crc = 0, size = 0;
    const check = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > e.size) { cb(new Error(`Zip entry ${e.name} is larger than recorded`)); return; }
        crc = crc32(chunk, crc);
        cb(null, chunk);
      },
    });
    const source = e.compSize > 0
      ? createReadStream(archive, { start: e.localOffset, end: e.localOffset + e.compSize - 1 })
      : Readable.from([]);
    const stages: NodeJS.ReadWriteStream[] = e.method === 8 && e.compSize > 0 ? [createInflateRaw()] : [];
    await pipeline([source, ...stages, check, createWriteStream(target, { mode: e.mode || 0o644 })], { signal });
    if (size !== e.size || (crc >>> 0) !== e.crc) throw new Error(`Zip entry ${e.name} is corrupt`);
    done += e.compSize;
    onFraction(done / total);
  }
}

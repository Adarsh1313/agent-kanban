// Downloads Google's pinned agy-acp-server release, checks its size and SHA-256 while it
// streams to disk, unpacks the two pinned files into a temp folder and renames that into
// place. Anything half-done (the .partial archive, the temp folder) is deleted on failure
// or cancel, and leftovers from a crashed run are swept before the next download.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, readdirSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readdir, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createInflateRaw, crc32 } from 'node:zlib';
import { resolveAntigravityRelease } from './antigravity-release.ts';
import type { AntigravityRelease } from './antigravity-release.ts';

export const DOWNLOAD_FAILED = "The download didn't finish. Try again.";
export const UNSUPPORTED_PLATFORM = "Google doesn't publish Antigravity for this computer.";
const DOWNLOAD_ORIGIN = 'https://dl.google.com';

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
  /** Origin the download must finally come from (after redirects). Tests only; default https://dl.google.com. */
  allowedOrigin?: string;
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

/** The pinned version if it's installed, else the newest older installed version, else null. */
export function findInstalledAntigravity(home: string, opts: PlatformOpts = {}): InstalledAntigravity | null {
  const release = releaseFor(opts);
  if (!release) return null;
  const root = antigravityRoot(home);
  const pinned = join(root, release.version, release.executable);
  if (isFile(pinned)) return { path: pinned, version: release.version };
  let names: string[];
  try { names = readdirSync(root); } catch { return null; }
  const found = names
    .filter((n) => VERSION_DIR.test(n) && compareVersions(n, release.version) <= 0 && isFile(join(root, n, release.executable)))
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

const failed = (why: string): Error => new Error(DOWNLOAD_FAILED, { cause: new Error(why) });

/** One install per version folder at a time: a second call gets the first call's promise. */
const inFlight = new Map<string, Promise<InstalledAntigravity>>();

/** Download, verify and unpack the pinned release. Resolves with the executable's path. */
export function installAntigravity(opts: InstallOptions): Promise<InstalledAntigravity> {
  const release = opts.release ?? resolveAntigravityRelease(opts.platform ?? process.platform, process.arch);
  if (!release) return Promise.reject(new Error(UNSUPPORTED_PLATFORM));
  const dir = join(antigravityRoot(opts.home), release.version);
  const running = inFlight.get(dir);
  if (running) return running;
  const p = runInstall(opts, release, dir).finally(() => inFlight.delete(dir));
  inFlight.set(dir, p);
  return p;
}

async function runInstall(opts: InstallOptions, release: AntigravityRelease, dir: string): Promise<InstalledAntigravity> {
  const existing = findInstalledAntigravity(opts.home, { release });
  if (existing && existing.version === release.version) return existing;

  const { signal, onProgress } = opts;
  const platform = opts.platform ?? process.platform;
  const root = antigravityRoot(opts.home);
  const partial = `${dir}.${randomUUID()}.partial`;
  let temp: string | null = null;
  const remove = (p: string) => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  const cleanup = async () => {
    await remove(partial);
    if (temp) await remove(temp);
  };

  try {
    signal.throwIfAborted();
    await mkdir(root, { recursive: true });
    // A version folder without its executable is a broken earlier install; a crashed run
    // may also have left a .partial download or an .extract-* folder. Start clean.
    await remove(dir);
    for (const n of await readdir(root)) {
      if (n.startsWith(`${release.version}.`) && (n.endsWith('.partial') || n.startsWith(`${release.version}.extract-`))) {
        await remove(join(root, n));
      }
    }

    const digest = await download(opts.fetch ?? fetch, release, partial, signal, onProgress, opts.allowedOrigin ?? DOWNLOAD_ORIGIN);

    onProgress({ phase: 'verify', fraction: 0 });
    if (digest !== release.sha256) throw failed('SHA-256 mismatch');
    if ((await stat(partial)).size !== release.archiveBytes) throw failed('Archive on disk has the wrong size');
    onProgress({ phase: 'verify', fraction: 1 });

    signal.throwIfAborted();
    onProgress({ phase: 'extract', fraction: 0 });
    temp = await mkdtemp(`${dir}.extract-`);
    const members = [
      { name: release.executable, bytes: release.executableBytes },
      { name: release.harness.name, bytes: release.harness.bytes },
    ];
    await extractZip(partial, temp, members, signal, (f) => onProgress({ phase: 'extract', fraction: Math.min(f, 0.99) }));
    if (platform !== 'win32') for (const m of members) await chmod(join(temp, m.name), 0o755);
    signal.throwIfAborted();
    await rename(temp, dir);
    temp = null;
    await remove(partial); // never turns a finished install into a failure
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
  allowedOrigin: string,
): Promise<string> {
  onProgress({ phase: 'download', fraction: 0 });
  const res = await fetchImpl(release.url, { signal });
  const discard = () => res.body?.cancel().catch(() => {});
  if (!res.ok || !res.body) { await discard(); throw new Error(`HTTP ${res.status}`); }
  let origin = '';
  try { origin = new URL(res.url).origin; } catch { /* empty or invalid url */ }
  if (origin !== allowedOrigin) { await discard(); throw new Error(`Download came from an unexpected place: ${origin || '(none)'}`); }
  // fetch decodes gzip itself, so content-length only means the archive size for identity bodies.
  const encoding = res.headers.get('content-encoding')?.trim().toLowerCase();
  const length = res.headers.get('content-length');
  if ((!encoding || encoding === 'identity') && length !== null && Number(length) !== release.archiveBytes) {
    await discard();
    throw new Error('Download size does not match the pinned release');
  }
  const hash = createHash('sha256');
  let bytes = 0;
  let reported = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > release.archiveBytes) { cb(new Error('Download is larger than the pinned release')); return; }
      hash.update(chunk);
      const f = bytes / release.archiveBytes;
      if (f - reported >= 0.01 || bytes === release.archiveBytes) {
        reported = f;
        onProgress({ phase: 'download', fraction: f });
      }
      cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
    meter,
    createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
    { signal },
  );
  if (bytes !== release.archiveBytes) throw new Error('Download ended early');
  return hash.digest('hex');
}

// ---- Zip reader: extracts only an allowlist of top-level files at exact sizes ----
// Stored + deflate; zip64 records/extra fields understood; encryption, other methods and
// non-regular entries rejected for the allowlisted names; everything else is skipped.

export interface ZipMember { name: string; bytes: number }
interface ZipEntry { name: string; flags: number; method: number; crc: number; compSize: number; size: number; localOffset: number; external: number }

const MAX32 = 0xffffffff;

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  if (bytesRead !== len) throw new Error('Zip archive is truncated');
  return buf;
}

function u64(buf: Buffer, at: number): number {
  const n = buf.readBigUInt64LE(at);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Zip value too large');
  return Number(n);
}

async function readEntries(fh: FileHandle): Promise<ZipEntry[]> {
  const size = (await fh.stat()).size;
  const tailLen = Math.min(size, 22 + 0xffff);
  const tailStart = size - tailLen;
  const tail = await readAt(fh, tailStart, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip archive');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  // Zip64 end-of-central-directory locator sits right before the classic record.
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
    const recOffset = u64(tail, eocd - 20 + 8);
    const rec = await readAt(fh, recOffset, 56);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw new Error('Bad zip64 end record');
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  } else if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
    throw new Error('Zip64 archive without its locator');
  }
  if (cdOffset + cdSize > size) throw new Error('Zip central directory is out of range');
  const cd = await readAt(fh, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad zip central directory');
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const e: ZipEntry = {
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      crc: cd.readUInt32LE(p + 16),
      compSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      external: cd.readUInt32LE(p + 38),
      localOffset: cd.readUInt32LE(p + 42),
      name: cd.toString('utf8', p + 46, p + 46 + nameLen),
    };
    // Zip64 extended information: 8-byte values for exactly the fields that are saturated, in this order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        const take = () => { if (q + 8 > x + 4 + len) throw new Error('Bad zip64 extra field'); const v = u64(cd, q); q += 8; return v; };
        if (e.size === MAX32) e.size = take();
        if (e.compSize === MAX32) e.compSize = take();
        if (e.localOffset === MAX32) e.localOffset = take();
      }
      x += 4 + len;
    }
    entries.push(e);
    p = xEnd + commentLen;
  }
  return entries;
}

/**
 * Unpack exactly `members` (top-level names, exact sizes) from a zip into dest, checking
 * each one's size and CRC-32. Other entries are skipped. Settles only after the file
 * being written is closed, so a cancel never leaves an open handle behind.
 */
export async function extractZip(
  archive: string,
  dest: string,
  members: ZipMember[],
  signal: AbortSignal,
  onFraction: (f: number) => void = () => {},
): Promise<void> {
  const fh = await open(archive, 'r');
  let plan: { e: ZipEntry; m: ZipMember; dataStart: number }[];
  try {
    const entries = await readEntries(fh);
    plan = [];
    for (const m of members) {
      const hits = entries.filter((e) => e.name === m.name);
      if (hits.length !== 1) throw new Error(`Zip must contain ${m.name} exactly once`);
      const e = hits[0];
      const unixType = (e.external >>> 16) & 0o170000;
      if (e.flags & 0x41) throw new Error(`Encrypted zip entry: ${e.name}`);
      if (e.method !== 0 && e.method !== 8) throw new Error(`Unsupported zip compression ${e.method}`);
      if ((unixType !== 0 && unixType !== 0o100000) || (e.external & 0x10)) throw new Error(`Not a regular file: ${e.name}`);
      if (e.size !== m.bytes) throw new Error(`${e.name} has the wrong size`);
      const lh = await readAt(fh, e.localOffset, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('Bad zip local header');
      plan.push({ e, m, dataStart: e.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28) });
    }
  } finally {
    await fh.close();
  }

  const total = members.reduce((s, m) => s + m.bytes, 0) || 1;
  let done = 0;
  let reported = 0;
  for (const { e, m, dataStart } of plan) {
    signal.throwIfAborted();
    let crc = 0, size = 0;
    const check = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > m.bytes) { cb(new Error(`${e.name} is larger than recorded`)); return; }
        crc = crc32(chunk, crc);
        const f = (done + size) / total;
        if (f - reported >= 0.01) { reported = f; onFraction(f); }
        cb(null, chunk);
      },
    });
    const source = e.compSize > 0
      ? createReadStream(archive, { start: dataStart, end: dataStart + e.compSize - 1 })
      : Readable.from([]);
    const stages: NodeJS.ReadWriteStream[] = e.method === 8 && e.compSize > 0 ? [createInflateRaw()] : [];
    // pipeline waits for every stream to close before it settles, including on abort.
    await pipeline([source, ...stages, check, createWriteStream(join(dest, m.name), { flags: 'wx', mode: 0o644 })], { signal });
    if (size !== m.bytes || (crc >>> 0) !== e.crc) throw new Error(`${e.name} is corrupt`);
    done += m.bytes;
  }
  onFraction(1);
}

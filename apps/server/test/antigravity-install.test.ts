import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { resolveAntigravityRelease } from '../src/connect/antigravity-release.ts';
import type { AntigravityRelease } from '../src/connect/antigravity-release.ts';
import {
  DOWNLOAD_FAILED, antigravityRoot, extractZip, findInstalledAntigravity, installAntigravity,
} from '../src/connect/antigravity-install.ts';
import type { InstallProgress } from '../src/connect/antigravity-install.ts';

const win = process.platform === 'win32';
const EXE = win ? 'agy_acp_server.exe' : 'agy_acp_server.par';
const HARNESS = win ? 'localharness_external.exe' : 'localharness_external';
const EXE_BODY = Buffer.from(randomBytes(384 * 1024).toString('base64')); // not very compressible
const HARNESS_BODY = Buffer.from('harness '.repeat(1000));

interface ZipFile { name: string; data: Buffer; method?: number; flags?: number; unixMode?: number; dosAttr?: number }

/** Build zip bytes in-process. With zip64, sizes/offsets live in zip64 extra fields + zip64 end records. */
function buildZip(files: ZipFile[], zip64 = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const method = f.method ?? (f.data.length ? 8 : 0);
    const comp = method === 8 ? deflateRawSync(f.data) : f.data;
    const crc = crc32(f.data) >>> 0;
    const extra = Buffer.alloc(zip64 ? 28 : 0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(f.data.length), 4); extra.writeBigUInt64LE(BigInt(comp.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(zip64 ? 45 : 20, 4); lh.writeUInt16LE(f.flags ?? 0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(zip64 ? 45 : 20, 6);
    ch.writeUInt16LE(f.flags ?? 0, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(zip64 ? 0xffffffff : comp.length, 20); ch.writeUInt32LE(zip64 ? 0xffffffff : f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE((((f.unixMode ?? 0o100644) << 16) | (f.dosAttr ?? 0)) >>> 0, 38);
    ch.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name, extra);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const tail: Buffer[] = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0); rec.writeBigUInt64LE(44n, 4); rec.writeUInt16LE(45, 12); rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(files.length), 24); rec.writeBigUInt64LE(BigInt(files.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40); rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(offset + cd.length), 8); loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 8); eocd.writeUInt16LE(zip64 ? 0xffff : files.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12); eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, cd, ...tail, eocd]);
}

const fixtureFiles = (): ZipFile[] => [
  { name: 'docs/', data: Buffer.alloc(0), unixMode: 0o040755 },
  { name: EXE, data: EXE_BODY },
  { name: 'README.txt', data: Buffer.from('not in the allowlist') },
  { name: HARNESS, data: HARNESS_BODY },
];

let server: Server;
let base = '';
let zip: Buffer;
let sha = '';
let work = '';
const hits = new Map<string, number>();

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'agy-install-'));
  zip = buildZip(fixtureFiles());
  sha = createHash('sha256').update(zip).digest('hex');
  server = createServer((req, res) => {
    hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1);
    if (req.url === '/ok.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zip.length) });
      // Several separately flushed chunks so progress has steps.
      const step = Math.ceil(zip.length / 8);
      let i = 0;
      const next = () => {
        if (i >= zip.length) { res.end(); return; }
        res.write(zip.subarray(i, i + step));
        i += step;
        setTimeout(next, 5);
      };
      next();
    } else if (req.url === '/stall.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zip.length) });
      res.write(zip.subarray(0, Math.floor(zip.length / 2))); // then never finish
    } else if (req.url === '/short.zip') {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(zip.subarray(0, zip.length - 10));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(work, { recursive: true, force: true });
});

function release(path: string, over: Partial<AntigravityRelease> = {}): AntigravityRelease {
  return {
    version: '1.3.0', url: `${base}${path}`, sha256: sha, archiveBytes: zip.length,
    executable: EXE, executableBytes: EXE_BODY.length, harness: { name: HARNESS, bytes: HARNESS_BODY.length }, ...over,
  };
}
const never = () => new AbortController().signal;
function install(home: string, path: string, over: Partial<AntigravityRelease> = {}, extra: Partial<Parameters<typeof installAntigravity>[0]> = {}) {
  return installAntigravity({ home, release: release(path, over), allowedOrigin: base, onProgress: () => {}, signal: never(), ...extra });
}
function freshHome(): string { return mkdtempSync(join(work, 'home-')); }
/** Everything left under the antigravity root (should be empty after a failure). */
function leftovers(home: string): string[] {
  const root = antigravityRoot(home);
  return existsSync(root) ? readdirSync(root).sort() : [];
}

test('release table: pinned win32-x64 values and all six platforms', () => {
  const r = resolveAntigravityRelease('win32', 'x64');
  assert.deepEqual(r, {
    version: '1.3.0',
    url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip',
    sha256: '65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9',
    archiveBytes: 124_509_787,
    executable: 'agy_acp_server.exe',
    executableBytes: 81_437_336,
    harness: { name: 'localharness_external.exe', bytes: 145_548_952 },
  });
  for (const [p, a] of [['win32', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    const x = resolveAntigravityRelease(p, a);
    assert.ok(x, `${p}-${a}`);
    assert.match(x.sha256, /^[0-9a-f]{64}$/);
    assert.ok(x.url.startsWith('https://dl.google.com/agy-extensions/releases/'));
    assert.equal(x.version, '1.3.0');
    assert.ok(x.executableBytes > 0 && x.harness.bytes > 0 && x.harness.name.startsWith('localharness_external'));
  }
});

test('unsupported platform → null release and nothing installed', () => {
  assert.equal(resolveAntigravityRelease('freebsd', 'x64'), null);
  assert.equal(resolveAntigravityRelease('linux', 'ia32'), null);
  assert.equal(findInstalledAntigravity(freshHome(), { platform: 'freebsd', arch: 'x64' }), null);
});

test('success: progress rises to 1, only the two pinned files are written, findInstalledAntigravity returns it', async () => {
  const home = freshHome();
  const events: InstallProgress[] = [];
  const out = await install(home, '/ok.zip', {}, { onProgress: (p) => events.push(p) });
  const dir = join(antigravityRoot(home), '1.3.0');
  const expected = join(dir, EXE);
  assert.deepEqual(out, { path: expected, version: '1.3.0' });
  assert.ok(readFileSync(expected).equals(EXE_BODY));
  assert.ok(readFileSync(join(dir, HARNESS)).equals(HARNESS_BODY));
  assert.deepEqual(readdirSync(dir).sort(), [EXE, HARNESS].sort(), 'README.txt and docs/ skipped');
  if (!win) {
    assert.ok(statSync(expected).mode & 0o100, 'executable bit set');
    assert.ok(statSync(join(dir, HARNESS)).mode & 0o100, 'harness executable bit set');
  }
  assert.deepEqual(leftovers(home), ['1.3.0'], 'no .partial or temp folders left');

  const dl = events.filter((e) => e.phase === 'download').map((e) => e.fraction);
  assert.ok(dl.length >= 3, `several download steps, got ${dl.length}`);
  for (let i = 1; i < dl.length; i++) assert.ok(dl[i] >= dl[i - 1], 'download fractions never go down');
  assert.equal(dl.at(-1), 1);
  assert.deepEqual(events.filter((e) => e.phase === 'verify').map((e) => e.fraction), [0, 1]);
  const ex = events.filter((e) => e.phase === 'extract').map((e) => e.fraction);
  for (let i = 1; i < ex.length; i++) assert.ok(ex[i] >= ex[i - 1], 'extract fractions never go down');
  assert.deepEqual(events.at(-1), { phase: 'extract', fraction: 1 });
  const phases = events.map((e) => e.phase);
  assert.ok(phases.lastIndexOf('download') < phases.indexOf('verify') && phases.lastIndexOf('verify') < phases.indexOf('extract'));

  assert.deepEqual(findInstalledAntigravity(home, { release: release('/ok.zip') }), out);
  // A second install is a no-op that returns the same install.
  let fetched = false;
  const again = await install(home, '/ok.zip', {}, { fetch: (async () => { fetched = true; throw new Error('no'); }) as typeof fetch });
  assert.deepEqual(again, out);
  assert.equal(fetched, false);
});

test('two concurrent installs share one download and resolve to the same result', async () => {
  const home = freshHome();
  const before = hits.get('/ok.zip') ?? 0;
  const [a, b] = await Promise.all([install(home, '/ok.zip'), install(home, '/ok.zip')]);
  assert.deepEqual(a, b);
  assert.equal((hits.get('/ok.zip') ?? 0) - before, 1, 'one download');
  assert.deepEqual(leftovers(home), ['1.3.0']);
});

test('checksum mismatch → message, broken version folder removed, no files; retry then works', async () => {
  const home = freshHome();
  const dir = join(antigravityRoot(home), '1.3.0');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'leftover.txt'), 'broken install without the executable');
  await assert.rejects(
    install(home, '/ok.zip', { sha256: 'f'.repeat(64) }),
    (e: Error) => e.message === DOWNLOAD_FAILED && DOWNLOAD_FAILED === "The download didn't finish. Try again.",
  );
  assert.equal(existsSync(dir), false, 'version folder is gone');
  assert.deepEqual(leftovers(home), []);
  assert.equal(findInstalledAntigravity(home, { release: release('/ok.zip') }), null);

  const ok = await install(home, '/ok.zip');
  assert.ok(existsSync(ok.path));
});

test('abort mid-download → rejects as cancelled and leaves no files', async () => {
  const home = freshHome();
  const ac = new AbortController();
  let partialSeen = false;
  let started = false;
  const p = install(home, '/stall.zip', {}, {
    signal: ac.signal,
    onProgress: (e) => {
      if (e.phase === 'download' && e.fraction > 0 && !started) {
        started = true;
        // The write stream opens its file asynchronously, so the first chunk can arrive before
        // the .partial exists (seen on Linux). Wait for it (the stalled body keeps the download open).
        void (async () => {
          for (let i = 0; i < 200 && !partialSeen; i++) {
            partialSeen = leftovers(home).some((n) => /^1\.3\.0\.[0-9a-f-]{36}\.partial$/.test(n));
            if (!partialSeen) await new Promise((r) => setTimeout(r, 10));
          }
          ac.abort();
        })();
      }
    },
  });
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
  assert.ok(partialSeen, 'download was streaming into 1.3.0.<uuid>.partial');
  assert.deepEqual(leftovers(home), []);
});

test('abort mid-extraction → rejects as cancelled and leaves no temp folder', async () => {
  const home = freshHome();
  const ac = new AbortController();
  let midway = false;
  const p = install(home, '/ok.zip', {}, {
    signal: ac.signal,
    onProgress: (e) => {
      if (e.phase === 'extract' && e.fraction > 0 && e.fraction < 0.5 && !ac.signal.aborted) {
        midway = leftovers(home).some((n) => n.startsWith('1.3.0.extract-'));
        ac.abort();
      }
    },
  });
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
  assert.ok(midway, 'aborted while the temp folder existed');
  assert.deepEqual(leftovers(home), []);
});

test('leftovers from a crashed run are swept before downloading', async () => {
  const home = freshHome();
  const root = antigravityRoot(home);
  mkdirSync(join(root, '1.3.0.extract-old', 'x'), { recursive: true });
  writeFileSync(join(root, '1.3.0.extract-old', 'x', 'f'), 'x');
  writeFileSync(join(root, '1.3.0.0b1c2d3e-0000-4000-8000-000000000000.partial'), 'half');
  writeFileSync(join(root, '1.3.0.partial'), 'half');
  await install(home, '/ok.zip');
  assert.deepEqual(leftovers(home), ['1.3.0']);
});

test('download ending early, wrong size, HTTP error or wrong origin → error and no files', async () => {
  const home = freshHome();
  await assert.rejects(install(home, '/short.zip'), { message: DOWNLOAD_FAILED });
  assert.deepEqual(leftovers(home), []);
  await assert.rejects(install(home, '/ok.zip', { archiveBytes: zip.length + 1 }), { message: DOWNLOAD_FAILED });
  await assert.rejects(install(home, '/missing.zip'), { message: DOWNLOAD_FAILED });
  // Default allowed origin is https://dl.google.com only; the local fixture isn't it.
  await assert.rejects(
    installAntigravity({ home, release: release('/ok.zip'), onProgress: () => {}, signal: never() }),
    (e: Error) => e.message === DOWNLOAD_FAILED && /unexpected place/.test(String((e.cause as Error).message)),
  );
  assert.deepEqual(leftovers(home), []);
});

test('archive missing a pinned file or with the wrong size → error and no files', async () => {
  const home = freshHome();
  await assert.rejects(install(home, '/ok.zip', { executable: 'not_there.exe' }), { message: DOWNLOAD_FAILED });
  await assert.rejects(install(home, '/ok.zip', { executableBytes: EXE_BODY.length - 1 }), { message: DOWNLOAD_FAILED });
  await assert.rejects(install(home, '/ok.zip', { harness: { name: HARNESS, bytes: 1 } }), { message: DOWNLOAD_FAILED });
  assert.deepEqual(leftovers(home), []);
});

test('findInstalledAntigravity falls back only to older installed versions', () => {
  const home = freshHome();
  const r = release('/ok.zip', { version: '1.4.0' });
  for (const v of ['1.2.0', '1.2.10', '1.5.0']) {
    mkdirSync(join(antigravityRoot(home), v), { recursive: true });
    writeFileSync(join(antigravityRoot(home), v, EXE), 'x');
  }
  mkdirSync(join(antigravityRoot(home), '1.3.9.extract-abc'), { recursive: true });
  assert.deepEqual(findInstalledAntigravity(home, { release: r }), { path: join(antigravityRoot(home), '1.2.10', EXE), version: '1.2.10' });
});

test('zip reader: allowlist only, zip64 fields, rejects encryption / methods / non-regular / CRC', async () => {
  const dir = mkdtempSync(join(work, 'zip-'));
  const members = [{ name: 'a.bin', bytes: 5 }, { name: 'e', bytes: 0 }];
  const run = async (files: ZipFile[], zip64 = false, m = members) => {
    const path = join(dir, `${Math.random()}.zip`);
    writeFileSync(path, buildZip(files, zip64));
    const out = mkdtempSync(join(dir, 'o-'));
    await extractZip(path, out, m, never());
    return out;
  };
  const good: ZipFile[] = [
    { name: 'a.bin', data: Buffer.from('hello') },
    { name: '../evil', data: Buffer.from('skipped, never written') },
    { name: 'e', data: Buffer.alloc(0) },
  ];
  for (const z64 of [false, true]) {
    const out = await run(good, z64);
    assert.deepEqual(readdirSync(out).sort(), ['a.bin', 'e']);
    assert.equal(readFileSync(join(out, 'a.bin'), 'utf8'), 'hello');
  }
  assert.equal(existsSync(join(dir, 'evil')), false);

  const a = (over: Partial<ZipFile>): ZipFile[] => [{ name: 'a.bin', data: Buffer.from('hello'), ...over }, { name: 'e', data: Buffer.alloc(0) }];
  await assert.rejects(run(a({ flags: 1 })), /Encrypted/);
  await assert.rejects(run(a({ method: 0, flags: 0x40 })), /Encrypted/);
  await assert.rejects(run(a({ method: 12 })), /Unsupported zip compression/);
  await assert.rejects(run(a({ unixMode: 0o120777 })), /Not a regular file/);
  await assert.rejects(run(a({ dosAttr: 0x10 })), /Not a regular file/);
  await assert.rejects(run([...a({}), { name: 'a.bin', data: Buffer.from('hello') }]), /exactly once/);
  await assert.rejects(run([{ name: 'e', data: Buffer.alloc(0) }]), /exactly once/);
  await assert.rejects(run(a({}), false, [{ name: 'a.bin', bytes: 4 }]), /wrong size/);

  const corrupt = buildZip(a({}));
  const cdStart = corrupt.readUInt32LE(corrupt.length - 6);
  corrupt.writeUInt32LE(0xdeadbeef, cdStart + 16); // central-directory CRC of a.bin
  const cpath = join(dir, 'corrupt.zip');
  writeFileSync(cpath, corrupt);
  await assert.rejects(extractZip(cpath, mkdtempSync(join(dir, 'o-')), members, never()), /corrupt/);
});

test('zip reader reads a zip made by Windows tar', { skip: !win && 'Windows-only fixture tool' }, async () => {
  const dir = mkdtempSync(join(work, 'tarzip-'));
  const src = join(dir, 'src');
  mkdirSync(src);
  writeFileSync(join(src, EXE), EXE_BODY);
  writeFileSync(join(src, HARNESS), HARNESS_BODY);
  const out = join(dir, 'fixture.zip');
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const r = spawnSync(tar, ['-a', '-c', '-f', out, '-C', src, EXE, HARNESS], { shell: false });
  assert.equal(r.status, 0, String(r.stderr));
  const dest = mkdtempSync(join(dir, 'o-'));
  await extractZip(out, dest, [{ name: EXE, bytes: EXE_BODY.length }, { name: HARNESS, bytes: HARNESS_BODY.length }], never());
  assert.ok(readFileSync(join(dest, EXE)).equals(EXE_BODY));
});

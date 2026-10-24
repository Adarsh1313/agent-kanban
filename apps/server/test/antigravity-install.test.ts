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
const EXE_BODY = randomBytes(96 * 1024).toString('base64'); // not very compressible: the zip has some size

/** Build zip bytes in-process (stored for empty, deflate otherwise) — portable across OSes. */
function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = f.data.length ? deflateRawSync(f.data) : Buffer.alloc(0);
    const method = f.data.length ? 8 : 0;
    const crc = crc32(f.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(((0o100644 << 16) >>> 0), 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** The fixture archive: on Windows made with the system tar (`tar -a -c -f`), elsewhere built in-process. */
function makeFixtureZip(work: string): Buffer {
  if (!win) return buildZip([{ name: EXE, data: Buffer.from(EXE_BODY) }, { name: HARNESS, data: Buffer.from('harness') }]);
  const src = join(work, 'src');
  mkdirSync(src);
  writeFileSync(join(src, EXE), EXE_BODY);
  writeFileSync(join(src, HARNESS), 'harness');
  const out = join(work, 'fixture.zip');
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const r = spawnSync(tar, ['-a', '-c', '-f', out, '-C', src, EXE, HARNESS], { shell: false });
  assert.equal(r.status, 0, String(r.stderr));
  return readFileSync(out);
}

let server: Server;
let base = '';
let zip: Buffer;
let sha = '';
let work = '';

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'agy-install-'));
  zip = makeFixtureZip(work);
  sha = createHash('sha256').update(zip).digest('hex');
  server = createServer((req, res) => {
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
  return { version: '1.3.0', url: `${base}${path}`, sha256: sha, archiveBytes: zip.length, executable: EXE, ...over };
}
function freshHome(): string { return mkdtempSync(join(work, 'home-')); }
/** Everything left under the antigravity root (should be empty after a failure). */
function leftovers(home: string): string[] {
  const root = antigravityRoot(home);
  return existsSync(root) ? readdirSync(root) : [];
}

test('release table: pinned win32-x64 values and all six platforms', () => {
  const r = resolveAntigravityRelease('win32', 'x64');
  assert.deepEqual(r, {
    version: '1.3.0',
    url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip',
    sha256: '65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9',
    archiveBytes: 124_509_787,
    executable: 'agy_acp_server.exe',
  });
  for (const [p, a] of [['win32', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    const x = resolveAntigravityRelease(p, a);
    assert.ok(x, `${p}-${a}`);
    assert.match(x.sha256, /^[0-9a-f]{64}$/);
    assert.ok(x.url.startsWith('https://dl.google.com/agy-extensions/releases/'));
    assert.equal(x.version, '1.3.0');
  }
});

test('unsupported platform → null release and nothing installed', () => {
  assert.equal(resolveAntigravityRelease('freebsd', 'x64'), null);
  assert.equal(resolveAntigravityRelease('linux', 'ia32'), null);
  assert.equal(findInstalledAntigravity(freshHome(), { platform: 'freebsd', arch: 'x64' }), null);
});

test('success: progress rises to 1, executable is in place, findInstalledAntigravity returns it', async () => {
  const home = freshHome();
  const events: InstallProgress[] = [];
  const out = await installAntigravity({ home, release: release('/ok.zip'), onProgress: (p) => events.push(p), signal: new AbortController().signal });
  const expected = join(antigravityRoot(home), '1.3.0', EXE);
  assert.deepEqual(out, { path: expected, version: '1.3.0' });
  assert.equal(readFileSync(expected, 'utf8'), EXE_BODY);
  assert.ok(existsSync(join(antigravityRoot(home), '1.3.0', HARNESS)));
  if (!win) assert.ok(statSync(expected).mode & 0o100, 'executable bit set');
  assert.deepEqual(leftovers(home), ['1.3.0'], 'no .partial or temp folders left');

  const dl = events.filter((e) => e.phase === 'download').map((e) => e.fraction);
  assert.ok(dl.length >= 3, `several download steps, got ${dl.length}`);
  for (let i = 1; i < dl.length; i++) assert.ok(dl[i] >= dl[i - 1], 'download fractions never go down');
  assert.equal(dl.at(-1), 1);
  assert.deepEqual(events.filter((e) => e.phase === 'verify').map((e) => e.fraction), [0, 1]);
  assert.deepEqual(events.at(-1), { phase: 'extract', fraction: 1 });
  const phases = events.map((e) => e.phase);
  assert.ok(phases.lastIndexOf('download') < phases.indexOf('verify') && phases.lastIndexOf('verify') < phases.indexOf('extract'));

  assert.deepEqual(findInstalledAntigravity(home, { release: release('/ok.zip') }), out);
  // A second install is a no-op that returns the same install.
  let fetched = false;
  const again = await installAntigravity({ home, release: release('/ok.zip'), fetch: (async () => { fetched = true; throw new Error('no'); }) as typeof fetch, onProgress: () => {}, signal: new AbortController().signal });
  assert.deepEqual(again, out);
  assert.equal(fetched, false);
});

test('checksum mismatch → "The download didn\'t finish. Try again." and no files; retry then works', async () => {
  const home = freshHome();
  await assert.rejects(
    installAntigravity({ home, release: release('/ok.zip', { sha256: 'f'.repeat(64) }), onProgress: () => {}, signal: new AbortController().signal }),
    (e: Error) => e.message === DOWNLOAD_FAILED && DOWNLOAD_FAILED === "The download didn't finish. Try again.",
  );
  assert.equal(existsSync(join(antigravityRoot(home), '1.3.0')), false, 'version folder is gone');
  assert.deepEqual(leftovers(home), []);
  assert.equal(findInstalledAntigravity(home, { release: release('/ok.zip') }), null);

  const ok = await installAntigravity({ home, release: release('/ok.zip'), onProgress: () => {}, signal: new AbortController().signal });
  assert.ok(existsSync(ok.path));
});

test('abort mid-download → rejects as cancelled and leaves no files', async () => {
  const home = freshHome();
  const ac = new AbortController();
  let partialSeen = false;
  const p = installAntigravity({
    home, release: release('/stall.zip'), signal: ac.signal,
    onProgress: (e) => {
      if (e.phase === 'download' && e.fraction > 0) {
        partialSeen = existsSync(join(antigravityRoot(home), '1.3.0.partial'));
        ac.abort();
      }
    },
  });
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
  assert.ok(partialSeen, 'download was streaming into 1.3.0.partial');
  assert.deepEqual(leftovers(home), []);
});

test('download ending early or with the wrong size → error and no files', async () => {
  const home = freshHome();
  await assert.rejects(
    installAntigravity({ home, release: release('/short.zip'), onProgress: () => {}, signal: new AbortController().signal }),
    { message: DOWNLOAD_FAILED },
  );
  assert.deepEqual(leftovers(home), []);
  // content-length differs from the pinned archive size
  await assert.rejects(
    installAntigravity({ home, release: release('/ok.zip', { archiveBytes: zip.length + 1 }), onProgress: () => {}, signal: new AbortController().signal }),
    { message: DOWNLOAD_FAILED },
  );
  // HTTP error
  await assert.rejects(
    installAntigravity({ home, release: release('/missing.zip'), onProgress: () => {}, signal: new AbortController().signal }),
    { message: DOWNLOAD_FAILED },
  );
  assert.deepEqual(leftovers(home), []);
});

test('archive without the executable → error and no files', async () => {
  const home = freshHome();
  await assert.rejects(
    installAntigravity({ home, release: release('/ok.zip', { executable: 'not_there.exe' }), onProgress: () => {}, signal: new AbortController().signal }),
    { message: DOWNLOAD_FAILED },
  );
  assert.deepEqual(leftovers(home), []);
});

test('findInstalledAntigravity falls back to an older installed version', () => {
  const home = freshHome();
  const r = release('/ok.zip', { version: '1.4.0' });
  for (const v of ['1.2.0', '1.2.10']) {
    mkdirSync(join(antigravityRoot(home), v), { recursive: true });
    writeFileSync(join(antigravityRoot(home), v, EXE), 'x');
  }
  mkdirSync(join(antigravityRoot(home), '1.9.0.extract-abc'), { recursive: true });
  assert.deepEqual(findInstalledAntigravity(home, { release: r }), { path: join(antigravityRoot(home), '1.2.10', EXE), version: '1.2.10' });
});

test('zip reader (Linux path): extracts and checks CRC; rejects unsafe names', async () => {
  const dir = mkdtempSync(join(work, 'zip-'));
  const good = join(dir, 'good.zip');
  writeFileSync(good, buildZip([{ name: 'a/b.txt', data: Buffer.from('hello') }, { name: 'empty', data: Buffer.alloc(0) }]));
  const out = join(dir, 'out');
  mkdirSync(out);
  await extractZip(good, out, new AbortController().signal);
  assert.equal(readFileSync(join(out, 'a', 'b.txt'), 'utf8'), 'hello');
  assert.equal(readFileSync(join(out, 'empty'), 'utf8'), '');

  for (const name of ['../evil', '/abs', 'a/../../evil', 'C:/x', 'a\\b']) {
    const bad = join(dir, 'bad.zip');
    writeFileSync(bad, buildZip([{ name, data: Buffer.from('x') }]));
    await assert.rejects(extractZip(bad, mkdtempSync(join(dir, 'o-')), new AbortController().signal), /Unsafe zip entry/, name);
  }
  assert.equal(existsSync(join(dir, 'evil')), false);

  const corrupt = buildZip([{ name: 'c.txt', data: Buffer.from('payload payload payload') }]);
  corrupt.writeUInt32LE(0xdeadbeef, 14); // local CRC (ignored)
  // central-directory CRC lives at cd offset + 16
  const cdStart = corrupt.readUInt32LE(corrupt.length - 6);
  corrupt.writeUInt32LE(0xdeadbeef, cdStart + 16);
  const cpath = join(dir, 'corrupt.zip');
  writeFileSync(cpath, corrupt);
  await assert.rejects(extractZip(cpath, mkdtempSync(join(dir, 'o-')), new AbortController().signal), /corrupt/);
});

test('install through the built-in zip reader (the Linux path) works on every OS', async () => {
  const home = freshHome();
  const out = await installAntigravity({ home, platform: 'linux', release: release('/ok.zip'), onProgress: () => {}, signal: new AbortController().signal });
  assert.equal(readFileSync(out.path, 'utf8'), EXE_BODY);
  assert.deepEqual(leftovers(home), ['1.3.0']);
});

// Renders the desktop app's icons from design/assets/*.svg (the source of truth) with Electron's own
// Chromium, so no image library is needed. Run: npm run desktop:icons. Output is committed.
//   icon.ico + icon.png           app icon (taskbar, Start menu, installer, window)
//   tray-on-{dark,light}[-needs]  tray mark, 16px plus @1.25x/@1.5x/@2x for display scaling
import { app, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const designAssets = join(here, '..', '..', '..', 'design', 'assets');
const out = join(here, '..', 'assets');
const tokens = readFileSync(join(here, '..', '..', '..', 'design', 'tokens.css'), 'utf8');
const token = (name: string) => {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(tokens);
  if (!m) throw new Error(`token ${name} not found in tokens.css`);
  return m[1];
};

const appSvg = readFileSync(join(designAssets, 'app-icon.svg'), 'utf8');
const traySvg = readFileSync(join(designAssets, 'tray-icon.svg'), 'utf8');
const tray = (colour: string, needs: boolean) => traySvg
  .replace('fill="currentColor"', `fill="${colour}"`)
  .replace(/<circle[^>]*class="needs-dot"[^>]*\/>/, needs ? `<circle cx="13.5" cy="12.5" r="2.5" fill="${token('--tray-dot')}"/>` : '');

async function render(win: BrowserWindow, svg: string, size: number): Promise<Buffer> {
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const dataUrl: string = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = c.height = ${size};
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size}); resolve(c.toDataURL('image/png')); };
    img.onerror = () => reject(new Error('svg failed to load'));
    img.src = ${JSON.stringify(url)};
  })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** An .ico holding PNG images (supported since Windows Vista). */
function ico(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

// Electron fires `ready` only after the main module finishes, so a top-level await on it would deadlock.
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  mkdirSync(out, { recursive: true });

  const icoImages = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) icoImages.push({ size, png: await render(win, appSvg, size) });
  writeFileSync(join(out, 'icon.ico'), ico(icoImages));
  writeFileSync(join(out, 'icon.png'), icoImages.at(-1)!.png);

  const scales: [string, number][] = [['', 16], ['@1.25x', 20], ['@1.5x', 24], ['@2x', 32]];
  for (const [taskbar, colour] of [['dark', token('--tray-on-dark')], ['light', token('--tray-on-light')]] as const) {
    for (const needs of [false, true]) {
      for (const [suffix, size] of scales) {
        writeFileSync(join(out, `tray-on-${taskbar}${needs ? '-needs' : ''}${suffix}.png`), await render(win, tray(colour, needs), size));
      }
    }
  }
  console.log(`icons written to ${out}`);
  app.quit();
});

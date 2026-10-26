import { spawn as nodeSpawn } from 'node:child_process';

export const ONLY_HTTPS = 'Only https links can be opened.';

/**
 * Opens an https link in the default browser. Never goes through a shell (the link holds & and %XX, which
 * cmd would interpret): Windows runs `rundll32.exe url.dll,FileProtocolHandler <href>`, macOS `open`, Linux
 * `xdg-open`, each with the link as one argument. Anything that isn't an https URL throws.
 */
export function openBrowser(
  url: string,
  opts: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn } = {},
): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(ONLY_HTTPS); }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) throw new Error(ONLY_HTTPS);
  const href = u.href;
  if (!/^[!-~]+$/.test(href)) throw new Error(ONLY_HTTPS);
  const platform = opts.platform ?? process.platform;
  const [command, args] = platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', href]]
    : platform === 'darwin' ? ['open', [href]] : ['xdg-open', [href]];
  const child = (opts.spawn ?? nodeSpawn)(command, args, { shell: false, stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', (e) => console.error("[agent-kanban] couldn't open the browser:", e.message));
  child.unref();
}

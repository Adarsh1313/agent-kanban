# Electron for the desktop app

The desktop app is an Electron shell that runs the existing Node server on Electron's own Node, so users install one thing and never need Node or a terminal. We accepted Electron's ~100 MB size because the server is Node either way: Tauri would still need a bundled Node sidecar (two runtimes), and the launcher + browser tab can't give a real window, tray or "keep running when closed" without a native helper anyway.

## Consequences

- The server must run on whatever Node version Electron bundles (`node:sqlite`, TypeScript type stripping). If it can't, bundle a separate Node binary for the server rather than rewriting it.
- Unsigned builds can't auto-update on Mac (Apple's updater requires signing), so updates are a "download the new version" link until the app is signed.

## Feasibility (2026-10-30)

Checked on Electron 45.1.0 (Node 24.22.1), run as Node: `node:sqlite`, TypeScript type stripping, the Claude Agent SDK and spawning provider binaries all work, and the real server starts, takes its lock and answers with its token. Electron's main process also loads TypeScript directly, so the desktop app needs no build step; only the sandboxed preload is plain CommonJS. No bundled Node is needed.

// Ported from pingdotgg/t3code (MIT), apps/server/src/provider/antigravityRelease.ts
// (commit 86534db4d3525a070589a234d660a3e0373a42ea). Copyright (c) 2026 T3 Tools Inc.
// See THIRD_PARTY_LICENSES. Google's official agy-acp-server release, pinned per platform.

export interface AntigravityRelease {
  version: string;
  url: string;
  sha256: string;
  archiveBytes: number;
  /** File name of the ACP server inside the archive (at its root). */
  executable: string;
  executableBytes: number;
  /** The local harness the server runs next to it. */
  harness: { name: string; bytes: number };
}

export const ANTIGRAVITY_RELEASE_VERSION = '1.3.0';

const v = ANTIGRAVITY_RELEASE_VERSION;
const BASE = 'https://dl.google.com/agy-extensions/releases';

const RELEASES: Record<string, AntigravityRelease> = {
  'darwin-arm64': {
    version: v,
    url: `${BASE}/macos/agy-acp-server-1.3.0-darwin-arm64.zip`,
    sha256: '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88',
    archiveBytes: 111_456_962,
    executable: 'agy_acp_server.par',
    executableBytes: 278_535_456,
    harness: { name: 'localharness_external', bytes: 118_611_392 },
  },
  'darwin-x64': {
    version: v,
    url: `${BASE}/macos/agy-acp-server-1.3.0-darwin-x86_64.zip`,
    sha256: 'bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646',
    archiveBytes: 117_245_544,
    executable: 'agy_acp_server.par',
    executableBytes: 282_840_688,
    harness: { name: 'localharness_external', bytes: 124_175_392 },
  },
  'linux-x64': {
    version: v,
    url: `${BASE}/linux/agy-acp-server-1.3.0-linux-x86_64.zip`,
    sha256: '9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96',
    archiveBytes: 333_727_150,
    executable: 'agy_acp_server.par',
    executableBytes: 926_533_965,
    harness: { name: 'localharness_external', bytes: 130_388_040 },
  },
  'linux-arm64': {
    version: v,
    url: `${BASE}/linux/agy-acp-server-1.3.0-linux-arm64.zip`,
    sha256: '500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf',
    archiveBytes: 321_690_363,
    executable: 'agy_acp_server.par',
    executableBytes: 930_848_992,
    harness: { name: 'localharness_external', bytes: 123_224_968 },
  },
  'win32-x64': {
    version: v,
    url: `${BASE}/windows/agy-acp-server-1.3.0-windows-x86_64.zip`,
    sha256: '65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9',
    archiveBytes: 124_509_787,
    executable: 'agy_acp_server.exe',
    executableBytes: 81_437_336,
    harness: { name: 'localharness_external.exe', bytes: 145_548_952 },
  },
  'win32-arm64': {
    version: v,
    url: `${BASE}/windows/agy-acp-server-1.3.0-windows-arm64.zip`,
    sha256: '4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3',
    archiveBytes: 124_654_803,
    executable: 'agy_acp_server.exe',
    executableBytes: 85_893_472,
    harness: { name: 'localharness_external.exe', bytes: 135_640_216 },
  },
};

/** The pinned release for this platform, or null when Google doesn't publish one. */
export function resolveAntigravityRelease(platform: string, arch: string): AntigravityRelease | null {
  const r = RELEASES[`${platform}-${arch}`];
  return r ? { ...r, harness: { ...r.harness } } : null;
}

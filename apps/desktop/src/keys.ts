// The user's own API keys (#43), kept by the main process only. Each key is encrypted with the operating
// system's key store (Electron safeStorage, passed in as `cipher`) and saved to keys.json beside the data
// it belongs to. The server asks for metadata, and for a key's value only just before it starts a provider.
// Spec: docs/specs/api-keys.md.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { KEY_PROVIDERS, type ApiKey, type KeyReply, type KeyRequest } from '@agent-kanban/shared';

export interface Cipher {
  /** False when the operating system has no key store we can use: no key is saved then. */
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

interface StoredKey extends ApiKey { cipher: string }

const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const meta = ({ cipher: _cipher, ...k }: StoredKey): ApiKey => k;

export class KeyFile {
  private path: string;
  private cipher: Cipher;
  private now: () => Date;

  constructor(opts: { path: string; cipher: Cipher; now?: () => Date }) {
    this.path = opts.path;
    this.cipher = opts.cipher;
    this.now = opts.now ?? (() => new Date());
  }

  /** Answers one request from the server. Errors are plain messages; they never contain a key. */
  handle(req: KeyRequest): KeyReply {
    try {
      return { ok: true, result: this.run(req) };
    } catch (e) {
      return { ok: false, error: e instanceof KeyFileError ? e.message : "Couldn't read or save your API keys." };
    }
  }

  private run(req: KeyRequest): unknown {
    const keys = this.read();
    switch (req.op) {
      case 'list': return keys.map(meta);
      case 'add': {
        if (!KEY_PROVIDERS.includes(req.provider)) throw new KeyFileError('Unknown provider.');
        const key = String(req.key ?? '').trim();
        if (!key) throw new KeyFileError('Paste the API key.');
        if (!this.cipher.available()) throw new KeyFileError("This computer can't store keys securely, so the key wasn't saved.");
        const stored: StoredKey = {
          id: randomUUID(), provider: req.provider, name: String(req.name).trim(), last4: key.slice(-4),
          capUsd: null, spentUsd: 0, month: monthOf(this.now()), cipher: this.cipher.encrypt(key).toString('base64'),
        };
        this.write([...keys, stored]);
        return meta(stored);
      }
      case 'update': {
        const i = keys.findIndex((k) => k.id === req.id);
        if (i < 0) return null;
        const { name, capUsd, spentUsd, month } = req.patch ?? {};
        const next: StoredKey = {
          ...keys[i]!,
          ...(typeof name === 'string' ? { name: name.trim() } : {}),
          ...(capUsd === null || typeof capUsd === 'number' ? { capUsd } : {}),
          ...(typeof spentUsd === 'number' ? { spentUsd } : {}),
          ...(typeof month === 'string' ? { month } : {}),
        };
        keys[i] = next;
        this.write(keys);
        return meta(next);
      }
      case 'remove': {
        const rest = keys.filter((k) => k.id !== req.id);
        if (rest.length === keys.length) return false;
        this.write(rest);
        return true;
      }
      case 'reveal': {
        const k = keys.find((x) => x.id === req.id);
        if (!k) return null;
        if (!this.cipher.available()) throw new KeyFileError("This computer's key store isn't available, so the key can't be read.");
        return this.cipher.decrypt(Buffer.from(k.cipher, 'base64'));
      }
    }
    throw new KeyFileError('Unknown request.');
  }

  private read(): StoredKey[] {
    if (!existsSync(this.path)) return [];
    const data = JSON.parse(readFileSync(this.path, 'utf8')) as { keys?: StoredKey[] };
    return Array.isArray(data.keys) ? data.keys : [];
  }

  private write(keys: StoredKey[]): void {
    // Write then rename, so a crash never leaves half a file (and every key lost).
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ keys }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

class KeyFileError extends Error {}

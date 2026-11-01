import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AdapterEvent, ProviderId } from '@agent-kanban/shared';
import { Store } from '../src/store.ts';
import { ChatService } from '../src/chats.ts';
import { createApi } from '../src/api.ts';
import { activeSpec, buildPreface, HANDOFF_TOKENS } from '../src/handoff.ts';

class Fake {
  id: ProviderId;
  starts: string[] = [];
  sends: string[] = [];
  resumes: string[] = [];
  listeners = new Set<(e: AdapterEvent) => void>();
  constructor(id: ProviderId) { this.id = id; }
  async startChat(i: { prompt: string }) { this.starts.push(i.prompt); return { sessionRef: `${this.id}-s` }; }
  async sendMessage(_ref: string, text: string) { this.sends.push(text); }
  async respondToRequest() {}
  async stop() {}
  async resume(ref: string) { this.resumes.push(ref); }
  onEvent(l: (e: AdapterEvent) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  async readUsage(): Promise<never> { throw new Error('unused'); }
  async listModels() { return []; }
  async ping() { return { ok: true, signedIn: true }; }
  async dispose() {}
  reply(text: string) {
    for (const l of this.listeners) {
      l({ type: 'message.completed', sessionRef: `${this.id}-s`, messageId: String(Math.random()), role: 'assistant', text });
      l({ type: 'turn.completed', sessionRef: `${this.id}-s` });
    }
  }
}

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'ak-handoff-'));
  mkdirSync(join(cwd, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'specs', 'done.md'), '# Done\n\n## Progress\n\n- [x] all\n');
  writeFileSync(join(cwd, 'docs', 'specs', 'login.md'), '# Login\n\n## Progress\n\n- [x] Slice 1: form\n- [ ] Slice 2: server\n');
  return cwd;
}

test('the active spec is the newest one with unchecked Progress lines', () => {
  const cwd = project();
  assert.deepEqual(activeSpec(cwd), { path: 'docs/specs/login.md', unchecked: ['- [ ] Slice 2: server'] });
  assert.equal(activeSpec(mkdtempSync(join(tmpdir(), 'ak-handoff-'))), null);
});

test('the preface keeps the newest messages within the budget', () => {
  const big = 'x'.repeat(HANDOFF_TOKENS * 4 / 2);
  const messages = ['first', big, big, 'last'].map((text, i) => ({ id: String(i), chatId: 'c', role: 'user' as const, text, createdAt: `2026-01-01T00:00:0${i}Z` }));
  const p = buildPreface({ to: 'codex', messages, cwd: '/nowhere' });
  assert.ok(p.includes('User: last'));
  assert.ok(!p.includes('User: first'));
  assert.ok(p.length < HANDOFF_TOKENS * 4 + 1000);
});

test('switching provider on send hands over with a preface; switching back sends only what happened since', async () => {
  const cwd = project();
  writeFileSync(join(cwd, 'notes.txt'), '');
  const store = new Store(':memory:');
  const claude = new Fake('claude');
  const codex = new Fake('codex');
  const svc = new ChatService({
    store, adapters: { claude, codex } as any, usage: { refresh: async () => [] } as any, broadcast: () => {}, claudeHome: '/nowhere',
    notes: () => 'We use pnpm.',
  });
  const api = createApi({ chats: svc, usage: { latest: () => [] } as any, history: async () => [], token: 'tok' });
  await new Promise<void>((r) => api.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const send = (id: string, body: unknown) => fetch(`${base}/api/chats/${id}/messages`, { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const chat = await svc.start({ provider: 'claude', cwd, prompt: 'Build login' });
    await svc.started(chat.id);
    claude.reply('Form done.');

    assert.equal((await send(chat.id, { text: 'Now the server', provider: 'codex' })).status, 204);
    await svc.started(chat.id);
    const first = codex.starts[0]!;
    assert.match(first, /User: Build login/);
    assert.match(first, /Claude Code: Form done\./);
    assert.match(first, /docs\/specs\/login\.md[\s\S]*- \[ \] Slice 2: server/);
    assert.match(first, /We use pnpm\./);
    assert.match(first, /Now the server$/);
    const after = svc.getChat(chat.id);
    assert.equal(after.provider, 'codex');
    assert.deepEqual(after.providerRefs, { claude: 'claude-s' });
    codex.reply('Server done.');
    assert.deepEqual(store.listMessages(chat.id).map((m) => m.provider), ['claude', 'claude', 'codex', 'codex']);

    await send(chat.id, { text: 'Review it', provider: 'claude' });
    assert.deepEqual(claude.resumes, ['claude-s']);
    const back = claude.sends[0]!;
    assert.match(back, /since you last took part/);
    assert.ok(!back.includes('Build login'));
    assert.match(back, /Codex: Server done\./);
    assert.equal(svc.getChat(chat.id).provider, 'claude');
  } finally {
    api.close(); api.server.closeAllConnections(); api.server.close();
  }
});

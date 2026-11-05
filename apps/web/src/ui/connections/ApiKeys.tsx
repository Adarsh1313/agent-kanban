// Your own API keys (#43): the "API keys" section on a provider's Connections card, the out-of-usage nudge
// that continues a chat on a key, its confirm, and the chat's "Using API key" and "Spend cap reached" lines.
// Keys are write-only: after saving, only their last 4 characters ever come back. Spec: docs/specs/api-keys.md.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { KEY_PROVIDERS, type ApiKey, type Chat, type KeyProvider, type ProviderId } from '@agent-kanban/shared';
import { api } from '../../api/client.ts';
import { desktopBridge } from '../../desktop.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { RESUME_TEXT } from '../board/Card.tsx';
import { runAction } from '../chat/ChatActionsMenu.tsx';
import { Dialog, Icon, providerName, toast } from '../primitives/index.ts';

const BILLER: Record<KeyProvider, string> = { claude: 'Anthropic', codex: 'OpenAI' };
export const DESKTOP_ONLY = 'API keys work in the desktop app only, where they are stored encrypted.';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const isKeyProvider = (p: ProviderId): p is KeyProvider => (KEY_PROVIDERS as ProviderId[]).includes(p);

/** "$3.20"; whole dollars drop the cents ("$10"). */
export function money(n: number, cents = false): string {
  return !cents && Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** "$3.20 of $10 this month", or "$3.20 this month" with no cap. */
export function spendLine(k: ApiKey): string {
  return k.capUsd === null ? `${money(k.spentUsd, true)} this month` : `${money(k.spentUsd, true)} of ${money(k.capUsd)} this month`;
}

export const capReached = (k: ApiKey) => k.capUsd !== null && k.spentUsd >= k.capUsd;

/** The keys (metadata only), loaded once in the desktop app; always null in browser mode. */
export function useKeys(): ApiKey[] | null {
  const store = useStoreInstance();
  const keys = useStore((s) => s.keys);
  const desktop = desktopBridge() !== null;
  useEffect(() => {
    if (!desktop || keys) return;
    api.keys().then((list) => store.setState((s) => ({ ...s, keys: list })), () => {});
  }, [desktop, keys, store]);
  return desktop ? keys : null;
}

function setKeys(store: ReturnType<typeof useStoreInstance>, update: (keys: ApiKey[]) => ApiKey[]): void {
  store.setState((s) => ({ ...s, keys: update(s.keys ?? []) }));
}

/** Parses the cap field: empty is no cap, otherwise a dollar amount above 0. */
function parseCap(text: string): number | null | undefined {
  const t = text.trim().replace(/^\$/, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The "API keys" section of a Claude Code or Codex Connections card. */
export function ApiKeysSection({ provider }: { provider: KeyProvider }) {
  const store = useStoreInstance();
  const all = useKeys();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ApiKey | null>(null);
  const headingId = useId();
  if (desktopBridge() === null) {
    return (
      <section className="api-keys" aria-label={`${providerName(provider)} API keys`}>
        <h3 className="api-keys-head">API keys</h3>
        <p className="conn-note"><Icon name="help" />{DESKTOP_ONLY}</p>
      </section>
    );
  }
  if (!all) return null;
  const keys = all.filter((k) => k.provider === provider);
  const run = async (fn: () => Promise<void>, done?: string) => {
    if (busy) return false;
    setBusy(true);
    try { await fn(); if (done) toast(done); return true; } catch (e) { toast(errText(e)); return false; } finally { setBusy(false); }
  };
  const remove = async (k: ApiKey) => {
    if (await run(async () => { await api.removeKey(k.id); setKeys(store, (ks) => ks.filter((x) => x.id !== k.id)); }, `Deleted ${k.name}.`)) setRemoving(null);
  };
  return (
    <section className="api-keys" aria-labelledby={headingId}>
      <h3 className="api-keys-head" id={headingId}>API keys</h3>
      <p className="conn-note"><Icon name="help" />Stored encrypted on this computer and never shown again. Billed per use by {BILLER[provider]}. Used only when you choose it for a chat.</p>
      {keys.length > 0 && (
        <ul className="api-key-list">
          {keys.map((k) => <KeyRow key={k.id} k={k} busy={busy} run={run} onRemove={() => setRemoving(k)} />)}
        </ul>
      )}
      {adding
        ? <AddKeyForm provider={provider} busy={busy} run={run} onDone={() => setAdding(false)} />
        : <button className="btn ghost" type="button" onClick={() => setAdding(true)}><Icon name="plus" size="sm" />Add an API key</button>}
      <Dialog open={removing !== null} onClose={() => { if (!busy) setRemoving(null); }} title={`Delete ${removing?.name ?? 'this key'}?`}
        footer={<><span className="grow" /><button className="btn ghost" type="button" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button>
          <button className="btn danger" type="button" disabled={busy} onClick={() => { if (removing) void remove(removing); }}>Delete key</button></>}>
        <p>It's removed from this computer. Chats using it go back to your {providerName(provider)} plan.</p>
      </Dialog>
    </section>
  );
}

type Run = (fn: () => Promise<void>, done?: string) => Promise<boolean>;

function KeyRow({ k, busy, run, onRemove }: { k: ApiKey; busy: boolean; run: Run; onRemove: () => void }) {
  const store = useStoreInstance();
  const [editing, setEditing] = useState<'name' | 'cap' | null>(null);
  const [draft, setDraft] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    let patch: { name?: string; capUsd?: number | null };
    if (editing === 'name') {
      if (!draft.trim()) return;
      patch = { name: draft.trim() };
    } else {
      const cap = parseCap(draft);
      if (cap === undefined) { toast('Enter a dollar amount above 0, or leave it empty for no cap.'); return; }
      patch = { capUsd: cap };
    }
    if (await run(async () => { const next = await api.patchKey(k.id, patch); setKeys(store, (ks) => ks.map((x) => (x.id === k.id ? next : x))); })) setEditing(null);
  };
  const capped = capReached(k);
  return (
    <li className="api-key-row">
      {editing ? (
        <form className="api-key-edit" onSubmit={(e) => void save(e)}>
          {editing === 'cap' && <span className="api-key-unit" aria-hidden="true">$</span>}
          <input aria-label={editing === 'name' ? `New name for ${k.name}` : `Monthly spend cap for ${k.name}, in dollars`} value={draft} autoFocus
            inputMode={editing === 'cap' ? 'decimal' : undefined} placeholder={editing === 'cap' ? 'No cap' : undefined} maxLength={60}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} />
          <button className="btn" type="submit" disabled={busy}>Save</button>
          <button className="btn ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
        </form>
      ) : (
        <>
          <span className="api-key-main">
            <span className="api-key-name">{k.name}</span>
            <span className="api-key-mask mono" aria-label={`ending in ${k.last4}`}>••••{k.last4}</span>
          </span>
          <span className={capped ? 'api-key-spend needs-text' : 'api-key-spend'}>{capped ? `Spend cap reached · ${spendLine(k)}` : spendLine(k)}</span>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => { setEditing('cap'); setDraft(k.capUsd === null ? '' : String(k.capUsd)); }}>
            {k.capUsd === null ? 'Set cap' : 'Change cap'}<span className="sr-only"> for {k.name}</span>
          </button>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => { setEditing('name'); setDraft(k.name); }}>Rename<span className="sr-only"> {k.name}</span></button>
          <button className="btn ghost icon-only" type="button" aria-label={`Delete ${k.name}`} aria-haspopup="dialog" disabled={busy} onClick={onRemove}><Icon name="x" size="sm" /></button>
        </>
      )}
    </li>
  );
}

function AddKeyForm({ provider, busy, run, onDone }: { provider: KeyProvider; busy: boolean; run: Run; onDone: () => void }) {
  const store = useStoreInstance();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [cap, setCap] = useState('');
  const capId = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const capUsd = parseCap(cap);
    if (capUsd === undefined) { toast('Enter a dollar amount above 0, or leave it empty for no cap.'); return; }
    const ok = await run(async () => {
      let added = await api.addKey(provider, name, key);
      // The key went once, to this computer's own server; drop it from the page at once.
      setKey('');
      if (capUsd !== null) added = await api.patchKey(added.id, { capUsd });
      setKeys(store, (ks) => [...ks.filter((x) => x.id !== added.id), added]);
    }, `Saved ${name.trim()}.`);
    if (ok) onDone();
  };
  return (
    <form className="api-key-add" onSubmit={(e) => void submit(e)} onKeyDown={(e) => { if (e.key === 'Escape') onDone(); }}>
      <label>Name<input value={name} maxLength={60} placeholder="Like Personal" autoFocus onChange={(e) => setName(e.target.value)} /></label>
      <label>API key<input type="password" value={key} autoComplete="off" spellCheck={false} placeholder="Paste it here" onChange={(e) => setKey(e.target.value)} /></label>
      <span className="api-key-field">
        <label htmlFor={capId}>Monthly spend cap</label>
        <span className="api-key-cap"><span aria-hidden="true">$</span><input id={capId} inputMode="decimal" value={cap} placeholder="No cap" aria-describedby={`${capId}-hint`} onChange={(e) => setCap(e.target.value)} /></span>
      </span>
      <small id={`${capId}-hint`} className="conn-note">Optional. The chat stops when this month's spend reaches it.</small>
      <span className="api-key-actions">
        <button className="btn primary" type="submit" disabled={busy || !name.trim() || !key.trim()}>Save key</button>
        <button className="btn ghost" type="button" onClick={onDone}>Cancel</button>
      </span>
    </form>
  );
}

/** Asks before a chat continues on a key: it shows the cap and says it is billed per use. */
export function UseKeyDialog({ chat, k, onClose }: { chat: Chat; k: ApiKey | null; onClose: () => void }) {
  const store = useStoreInstance();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!k || busy) return;
    setBusy(true);
    const ok = await runAction(store, () => api.useKey(chat.id, k.id));
    setBusy(false);
    if (ok) onClose();
  };
  const biller = isKeyProvider(chat.provider) ? BILLER[chat.provider] : 'the provider';
  return (
    <Dialog open={k !== null} onClose={() => { if (!busy) onClose(); }} title={`Continue with API key '${k?.name ?? ''}'?`}
      footer={<><span className="grow" /><button className="btn ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn primary" type="button" disabled={busy} onClick={() => void go()}>Continue</button></>}>
      <p>This chat runs on your own API key until you switch back. It's billed per use by {biller}.</p>
      {k && <p>{k.capUsd === null ? `No spend cap set. ${money(k.spentUsd, true)} used this month.` : `Spend cap: ${money(k.capUsd)} a month. ${money(k.spentUsd, true)} used so far.`}</p>}
    </Dialog>
  );
}

/** The out-of-usage nudge's key buttons: "Continue with API key 'Personal'" for each key of the chat's provider. */
export function UseKeyButtons({ chat }: { chat: Chat }) {
  const keys = useKeys();
  const [asking, setAsking] = useState<ApiKey | null>(null);
  const mine = (keys ?? []).filter((k) => k.provider === chat.provider && k.id !== chat.keyId && !capReached(k));
  if (mine.length === 0) return null;
  return (
    <div className="switch-accounts">
      {mine.map((k) => (
        <button key={k.id} className="btn" type="button" aria-haspopup="dialog" onClick={() => setAsking(k)}>
          Continue with API key '{k.name}'<small className="api-key-billed">billed per use</small>
        </button>
      ))}
      <UseKeyDialog chat={chat} k={asking} onClose={() => setAsking(null)} />
    </div>
  );
}

/** Under the panel title while a chat runs on a key: which key, and the way back to the plan. */
export function UsingKey({ chat }: { chat: Chat }) {
  const store = useStoreInstance();
  const keys = useKeys();
  if (!chat.keyId) return null;
  const k = keys?.find((x) => x.id === chat.keyId);
  const canSwitch = chat.column !== 'running';
  return (
    <span className="using-key">
      <span>Using API key '{k?.name ?? 'Unknown'}'{k ? ` · ${spendLine(k)}` : ''}</span>
      {canSwitch && <button className="btn ghost" type="button" onClick={() => void runAction(store, () => api.useKey(chat.id, null))}>Use my plan</button>}
    </span>
  );
}

/** Needs you · Spend cap reached: say which cap, and offer to carry on with the plan instead. */
export function SpendCapNote({ chat }: { chat: Chat }) {
  const store = useStoreInstance();
  const keys = useKeys();
  const k = keys?.find((x) => x.id === chat.keyId);
  const back = () => void runAction(store, async () => {
    await api.useKey(chat.id, null);
    await api.send(chat.id, RESUME_TEXT);
  });
  return (
    <div className="out-of-usage">
      <p className="spend-cap-text">
        {k && k.capUsd !== null ? `API key '${k.name}' reached its ${money(k.capUsd)} cap for this month.` : 'This API key reached its spend cap.'}
        {' '}Raise the cap in Connections, or continue on your plan.
      </p>
      <div className="switch-accounts"><button className="btn" type="button" onClick={back}>Continue on your plan</button></div>
    </div>
  );
}

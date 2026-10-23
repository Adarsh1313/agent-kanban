import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ConnectionHealth, ModelOption, Project, ProviderId, UsageReading } from '@agent-kanban/shared';
import { ApiError, api } from '../../api/client.ts';
import type { AppState } from '../../state/reducer.ts';
import { baseName, focusedProvider, suggestFor } from '../../state/selectors.ts';
import { useStore } from '../../state/store.ts';
import { setNewChatHandler, type NewChatOptions } from '../actions.ts';
import { Dialog, Icon, Popover, PROVIDER_IDS, ProviderLogo, providerName, toast } from '../primitives/index.ts';
import { cssMs, cssValue, reducedMotion } from '../primitives/motion.ts';

export const FOLDER_MISSING = "That folder doesn't exist.";

type ModelList = Record<ProviderId, ModelOption[]>;

/** /api/models asks every provider's CLI, so it is fetched once and shared; a failure is retried on the next open. */
let modelsCache: Promise<ModelList> | null = null;
function loadModels(): Promise<ModelList> {
  if (!modelsCache) {
    modelsCache = api.models().catch((e: unknown) => {
      modelsCache = null;
      throw e;
    });
  }
  return modelsCache;
}
/** Tests start each case without a cached model list. */
export const resetModelsCache = () => { modelsCache = null; };

const STATUS_TEXT: Record<ConnectionHealth['status'], string> = {
  connected: 'Connected',
  update_available: 'Connected',
  signed_out: 'Not signed in',
  not_installed: 'Not installed',
  degraded: 'Needs attention',
};

export const isConnected = (c: ConnectionHealth | undefined) => c?.status === 'connected' || c?.status === 'update_available';

/** Folder paths compare without trailing separators, and case-insensitively for Windows drive paths. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const t = p.trim().replace(/[\\/]+$/, '');
    return /^[a-z]:/i.test(t) ? t.replace(/\//g, '\\').toLowerCase() : t;
  };
  return norm(a) === norm(b);
}

export const findProject = (projects: Project[], path: string) =>
  path.trim() ? projects.find((p) => p.id.trim() !== '' && (samePath(p.id, path) || samePath(p.path, path))) : undefined;

/** Folders a chat can start in (history can carry chats with no folder). */
const usable = (projects: Project[]) => projects.filter((p) => p.id.trim() !== '');

/** The focused provider's latest project, else the latest project. */
function latestProject(projects: Project[], focus: ProviderId | null): Project | undefined {
  const sorted = usable(projects).sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
  return (focus && sorted.find((p) => p.providers.some((x) => x.provider === focus))) || sorted[0];
}

/** The model the server lists as "default" is what Default already means, so it is not offered twice. */
const listedModels = (list: ModelOption[]) => list.filter((m) => m.id !== 'default');
function defaultHint(list: ModelOption[], provider: ProviderId | null): string {
  const d = list.find((m) => m.isDefault && m.id !== 'default');
  return d ? `Uses ${d.label}` : `Uses ${provider ? providerName(provider) : 'the provider'}'s own default`;
}

/** Providers New chat can start on for a folder: connected ones that have worked in it (any connected one for a new folder). */
export function allowedProviders(s: Pick<AppState, 'connections'>, project: Project | undefined): ProviderId[] {
  const connected = PROVIDER_IDS.filter((id) => isConnected(s.connections[id]));
  if (!project) return connected;
  const worked = new Set(project.providers.map((p) => p.provider));
  return connected.filter((id) => worked.has(id));
}

const levelOf = (left: number) => (left < 5 ? 'out' : left < 25 ? 'low' : 'ok');
const windowOf = (r: UsageReading | undefined, kind: 'five_hour' | 'weekly') => r?.windows.find((w) => w.kind === kind);
const pct = (left: number | undefined) => (left === undefined ? '—' : `${Math.round(left)}%`);

/** "5-hour 82% left · Weekly 64% left", or "—" for a window with no reading. */
export function usageText(r: UsageReading | undefined): string {
  const five = windowOf(r, 'five_hour')?.leftPct;
  const week = windowOf(r, 'weekly')?.leftPct;
  return `5-hour ${pct(five)}${five === undefined ? '' : ' left'} · Weekly ${pct(week)}${week === undefined ? '' : ' left'}`;
}

function MiniMeter({ reading }: { reading: UsageReading | undefined }) {
  const five = windowOf(reading, 'five_hour');
  const week = windowOf(reading, 'weekly');
  if (!five && !week) return null;
  const bar = (w: typeof five) => w
    ? <i data-level={levelOf(w.leftPct)} style={{ ['--left' as string]: w.leftPct / 100 }} />
    : <i />;
  return <span className="minimeter" aria-hidden="true">{bar(five)}{bar(week)}</span>;
}

const joinNames = (ids: ProviderId[]) => {
  const names = ids.map(providerName);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

type Picker = 'project' | 'provider' | 'model' | null;
/** A known project (by id), or a folder typed by hand. */
type Where = { kind: 'project'; id: string } | { kind: 'path' };

const pickState = (s: AppState) => ({ projects: s.projects, connections: s.connections, usage: s.usage, suggested: s.suggested, focus: focusedProvider(s), loaded: s.loaded });

export function NewChatDialog() {
  const st = useStore(pickState);
  const [open, setOpen] = useState(false);
  const [where, setWhere] = useState<Where>({ kind: 'path' });
  const [path, setPath] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  /** The user's own pick; null (or a pick that is no longer allowed) means the suggested one. */
  const [chosen, setChosen] = useState<ProviderId | null>(null);
  /** The model belongs to the provider it was picked for, so switching providers goes back to Default. */
  const [model, setModel] = useState<{ provider: ProviderId; id: string } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [emptyHint, setEmptyHint] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [picker, setPicker] = useState<Picker>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const stRef = useRef(st);
  stRef.current = st;
  const autoPick = useRef(false);

  useEffect(() => {
    if (!open || !autoPick.current) return;
    const target = latestProject(st.projects, st.focus);
    if (!target) return;
    autoPick.current = false;
    // The path field goes away: its focus moves to the prompt.
    const hadFocus = document.activeElement === pathRef.current;
    setWhere({ kind: 'project', id: target.id });
    if (hadFocus) requestAnimationFrame(() => promptRef.current?.focus({ preventScroll: true }));
  }, [open, st.projects, st.focus]);

  useEffect(() => {
    setNewChatHandler((opts?: NewChatOptions) => {
      const { projects, focus, connections } = stRef.current;
      const target = opts?.cwd ? findProject(projects, opts.cwd) : latestProject(projects, focus);
      // Opened before the projects loaded: pick the latest one when they arrive, unless a folder was typed.
      autoPick.current = !opts?.cwd && !target;
      if (target) {
        setWhere({ kind: 'project', id: target.id });
        setPath('');
      } else {
        setWhere({ kind: 'path' });
        setPath(opts?.cwd ?? '');
      }
      setChosen(focus && allowedProviders({ connections }, target).includes(focus) ? focus : null);
      setModel(null);
      setPathError(null);
      setEmptyHint(false);
      setPicker(null);
      setOpen(true);
    });
    return () => setNewChatHandler(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    // After the dialog moved focus in (child effects run first): the prompt, or the path field when a folder is needed.
    if (where.kind === 'path' && !path) pathRef.current?.focus({ preventScroll: true });
    else promptRef.current?.focus({ preventScroll: true });
    let live = true;
    loadModels().then((m) => { if (live) setModels(m); }, () => { /* only Default is offered */ });
    return () => { live = false; };
  }, [open]);

  const project = where.kind === 'project' ? st.projects.find((p) => p.id === where.id) : findProject(st.projects, path);
  const allowed = allowedProviders(st, project);
  const suggestion = suggestFor(st, allowed);
  const provider: ProviderId | null = chosen && allowed.includes(chosen) ? chosen : suggestion?.provider ?? null;
  const modelId = model && model.provider === provider ? model.id : null;
  // Any provider change (picked, or forced by a project switch) goes back to Default for good.
  useEffect(() => { setModel((m) => (m && m.provider !== provider ? null : m)); }, [provider]);
  const allModels = provider && models ? models[provider] ?? [] : [];
  const providerModels = listedModels(allModels);
  const modelLabel = modelId ? allModels.find((m) => m.id === modelId)?.label ?? modelId : 'Default';
  const projectName = where.kind === 'project' ? project?.name ?? baseName(where.id) : project?.name ?? (path.trim() ? baseName(path.trim()) : 'Another folder');
  const showSuggested = (id: ProviderId) => suggestion?.suggested === true && suggestion.provider === id && allowed.length > 1;

  const close = () => { autoPick.current = false; setOpen(false); setPicker(null); };
  const openPicker = (kind: Exclude<Picker, null>, el: HTMLElement) => {
    if (picker === kind) { setPicker(null); return; }
    setAnchor(el);
    setPicker(kind);
  };

  const nudge = () => {
    setEmptyHint(true);
    promptRef.current?.focus();
    // A small sideways shake (as design/board.html does); with reduced motion the outline and hint say it instead.
    const el = promptRef.current;
    if (el && !reducedMotion() && typeof el.animate === 'function') {
      const d = cssValue('--space-1', '4px');
      el.animate([{ transform: 'translateX(0)' }, { transform: `translateX(-${d})` }, { transform: `translateX(${d})` }, { transform: 'translateX(0)' }],
        { duration: cssMs('--duration-dialog', 200), easing: cssValue('--ease-out', 'ease-out') });
    }
  };

  const start = async () => {
    if (busyRef.current) return;
    const text = prompt.trim();
    if (!text) { nudge(); return; }
    const cwd = where.kind === 'project' ? project?.path ?? where.id : path.trim();
    if (!cwd) { setPathError('Enter the folder to work in.'); pathRef.current?.focus(); return; }
    if (!provider) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api.startChat({ provider, cwd, prompt: text, ...(modelId ? { model: modelId } : {}) });
      // The card arrives in Running through the server's chat.updated event.
      setPrompt('');
      setPathError(null);
      close();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (where.kind === 'path' && e instanceof ApiError && e.status === 400 && message === FOLDER_MISSING) {
        setPathError(message);
        pathRef.current?.focus();
      } else toast(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      e.preventDefault();
      void start();
    }
  };

  let note: string | null = null;
  if (!st.loaded) note = null; // connections and projects are still loading
  else if (allowed.length === 0) {
    note = project
      ? `None of your connected providers has worked on ${projectName} yet. Choose another folder to start fresh.`
      : 'No provider is connected yet. Connect one on the Connections page.';
  } else if (project && allowed.length < PROVIDER_IDS.length) {
    const worked = PROVIDER_IDS.filter((id) => project.providers.some((p) => p.provider === id));
    if (worked.length < PROVIDER_IDS.length) {
      note = `${projectName} has been worked on with ${joinNames(worked)}, so ${worked.length > 1 ? 'those are the providers that know' : 'that’s the provider that knows'} it.`;
    }
  }

  const hint = emptyHint ? 'Write what the agent should do first.' : provider ? `${providerName(provider)}: ${usageText(st.usage[provider])}` : '';

  return (
    <>
      <Dialog
        open={open}
        onClose={close}
        title="New chat"
        footer={<>
          <span className={`grow dlg-hint${emptyHint ? ' warn' : ''}`} aria-live="polite">{hint}</span>
          <button className="btn ghost" type="button" onClick={close}>Cancel</button>
          <button className="btn primary" type="button" disabled={busy || !provider} onClick={() => void start()}>
            Start chat <span className="kbd">Ctrl ↵</span>
          </button>
        </>}
      >
        <textarea
          ref={promptRef}
          className={emptyHint ? 'invalid' : undefined}
          name="prompt"
          autoComplete="off"
          placeholder="What should the agent do next? For example: add a dark mode toggle…"
          aria-label="Prompt"
          aria-invalid={emptyHint || undefined}
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); if (e.target.value.trim()) setEmptyHint(false); }}
          onKeyDown={onKey}
        />
        {where.kind === 'path' && (
          <div className="dlg-path">
            <input
              ref={pathRef}
              className="dlg-path-input"
              type="text"
              name="cwd"
              autoComplete="off"
              spellCheck={false}
              placeholder="Folder path, for example C:\Users\me\my-app"
              aria-label="Folder path"
              aria-invalid={pathError ? true : undefined}
              aria-describedby={pathError ? 'dlg-path-error' : undefined}
              value={path}
              onChange={(e) => { autoPick.current = false; setPath(e.target.value); setPathError(null); }}
              onKeyDown={onKey}
            />
            {pathError && <p className="dlg-path-error" id="dlg-path-error" role="alert">{pathError}</p>}
          </div>
        )}
        <div className="dlg-chips">
          <button className="chip-btn" type="button" aria-haspopup="listbox" aria-expanded={picker === 'project'} aria-label={`Project: ${projectName}`} onClick={(e) => openPicker('project', e.currentTarget)}>
            <Icon name="folder" size="sm" />{projectName}<Icon name="chevron-down" size="sm" />
          </button>
          <button className="chip-btn" type="button" aria-haspopup="listbox" aria-expanded={picker === 'provider'} aria-label={`Provider: ${provider ? providerName(provider) : 'none'}`} onClick={(e) => openPicker('provider', e.currentTarget)}>
            {provider ? <><ProviderLogo id={provider} size="sm" />{providerName(provider)}{showSuggested(provider) && <span className="suggested">Suggested</span>}</> : 'No provider'}
            <Icon name="chevron-down" size="sm" />
          </button>
          <button className="chip-btn" type="button" aria-haspopup="listbox" aria-expanded={picker === 'model'} aria-label={`Model: ${modelLabel}`} disabled={!provider} onClick={(e) => openPicker('model', e.currentTarget)}>
            {modelLabel}<Icon name="chevron-down" size="sm" />
          </button>
        </div>
        {note && <div className="dlg-note"><Icon name="projects" size="sm" />{note}</div>}
      </Dialog>

      <Popover anchor={anchor} open={open && picker === 'project'} onClose={() => setPicker(null)} label="Project" className="menu dlg-pop" role="listbox">
        <div className="pane">
          <div className="menu-label">Projects found on this computer</div>
          {usable(st.projects).length === 0 && <div className="menu-label">None yet</div>}
          <div className="dlg-scroll">
            {usable(st.projects).map((p) => {
              const selected = where.kind === 'project' && where.id === p.id;
              return (
                <button key={p.id} className="menu-item" type="button" role="option" aria-selected={selected} title={p.path}
                  onClick={() => { setWhere({ kind: 'project', id: p.id }); setPathError(null); setPicker(null); promptRef.current?.focus(); }}>
                  <Icon name="folder" size="sm" />
                  <span className="grow-text">{p.name}</span>
                  <span className="r">
                    {PROVIDER_IDS.filter((id) => p.providers.some((x) => x.provider === id)).map((id) => <ProviderLogo key={id} id={id} size="sm" />)}
                    {selected && <Icon name="check" size="sm" />}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="menu-sep" />
          <button className="menu-item" type="button" role="option" aria-selected={where.kind === 'path'}
            onClick={() => {
              if (where.kind === 'project' && project) setPath(project.path);
              setWhere({ kind: 'path' });
              setPicker(null);
              requestAnimationFrame(() => { pathRef.current?.focus(); pathRef.current?.select(); });
            }}>
            <Icon name="folder" />Choose another folder…
          </button>
        </div>
      </Popover>

      <Popover anchor={anchor} open={open && picker === 'provider'} onClose={() => setPicker(null)} label="Provider" className="menu dlg-pop" role="listbox">
        <div className="pane">
          <div className="menu-label">Start on</div>
          {PROVIDER_IDS.map((id) => {
            const conn = st.connections[id];
            const ok = allowed.includes(id);
            const reason = !isConnected(conn) ? (conn ? STATUS_TEXT[conn.status] : 'Not connected') : `Hasn't worked on ${projectName} yet`;
            return (
              <button key={id} className="pick-row" type="button" role="option" aria-selected={provider === id} aria-disabled={ok ? undefined : true}
                onClick={() => { if (!ok) return; setChosen(id); setPicker(null); promptRef.current?.focus(); }}>
                <ProviderLogo id={id} size="lg" />
                <span className="t">
                  <b>{providerName(id)}{ok && showSuggested(id) && <span className="suggested">Suggested</span>}</b>
                  <small>{ok ? usageText(st.usage[id]) : reason}</small>
                </span>
                {ok && <MiniMeter reading={st.usage[id]} />}
                <span className="check"><Icon name="check" size="sm" /></span>
              </button>
            );
          })}
        </div>
      </Popover>

      <Popover anchor={anchor} open={open && picker === 'model' && provider !== null} onClose={() => setPicker(null)} label="Model" className="menu dlg-pop" role="listbox">
        <div className="pane">
          <div className="menu-label">{provider ? `${providerName(provider)} models` : 'Models'}</div>
          <button className="pick-row" type="button" role="option" aria-selected={modelId === null}
            onClick={() => { setModel(null); setPicker(null); promptRef.current?.focus(); }}>
            <span className="t"><b>Default</b><small>{defaultHint(allModels, provider)}</small></span>
            <span className="check"><Icon name="check" size="sm" /></span>
          </button>
          {providerModels.map((m) => (
            <button key={m.id} className="pick-row" type="button" role="option" aria-selected={modelId === m.id}
              onClick={() => { if (provider) setModel({ provider, id: m.id }); setPicker(null); promptRef.current?.focus(); }}>
              <span className="t"><b>{m.label}</b></span>
              <span className="check"><Icon name="check" size="sm" /></span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

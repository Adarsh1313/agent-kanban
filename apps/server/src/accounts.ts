import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, AccountProvider } from '@agent-kanban/shared';
import type { SettingsBackend } from './settings.ts';

export const ACCOUNT_PROVIDERS: AccountProvider[] = ['claude', 'codex'];
export const DEFAULT_ACCOUNT = 'default';

/** Each provider's own config folder setting, and the folder of chats shared across its accounts. */
const HOME_ENV: Record<AccountProvider, { env: string; shared: string }> = {
  claude: { env: 'CLAUDE_CONFIG_DIR', shared: 'projects' },
  codex: { env: 'CODEX_HOME', shared: 'sessions' },
};

export class AccountError extends Error {}

type Stored = { id: string; name: string; configDir: string };

/**
 * Several sign-ins per provider (#39): each extra account is its own config folder, and one is active. The
 * account the user already had is "Default" (the provider's own folder). Every account links the default's
 * chats folder, so chats stay in the same history and can be continued whichever account is active.
 */
export class AccountStore {
  private backend: SettingsBackend;
  private root: string;
  private providerHome: Record<AccountProvider, string>;
  private link: (target: string, path: string) => void;

  constructor(opts: { backend: SettingsBackend; root: string; providerHome: Record<AccountProvider, string>; link?: (target: string, path: string) => void }) {
    this.backend = opts.backend;
    this.root = opts.root;
    this.providerHome = opts.providerHome;
    // A junction needs no admin rights on Windows; other systems ignore the type.
    this.link = opts.link ?? ((target, path) => symlinkSync(target, path, 'junction'));
  }

  list(provider: AccountProvider): Account[] {
    const active = this.activeId(provider);
    const all = [{ id: DEFAULT_ACCOUNT, name: 'Default', configDir: null }, ...this.stored(provider)];
    return all.map((a) => ({ id: a.id, provider, name: a.name, active: a.id === active }));
  }

  add(provider: AccountProvider, name: string): Account {
    const clean = this.validName(provider, name);
    const id = randomUUID();
    const configDir = join(this.root, provider, id);
    mkdirSync(configDir, { recursive: true });
    const shared = join(this.providerHome[provider], HOME_ENV[provider].shared);
    mkdirSync(shared, { recursive: true });
    try { this.link(shared, join(configDir, HOME_ENV[provider].shared)); } catch { /* no link: its chats stay with that account */ }
    this.save(provider, [...this.stored(provider), { id, name: clean, configDir }]);
    return this.list(provider).find((a) => a.id === id)!;
  }

  rename(provider: AccountProvider, id: string, name: string): Account {
    if (id === DEFAULT_ACCOUNT) throw new AccountError("The Default account can't be renamed.");
    const clean = this.validName(provider, name, id);
    const all = this.stored(provider);
    if (!all.some((a) => a.id === id)) throw new AccountError('That account no longer exists.');
    this.save(provider, all.map((a) => (a.id === id ? { ...a, name: clean } : a)));
    return this.list(provider).find((a) => a.id === id)!;
  }

  /** Removes the account's sign-in; its chats stay in the shared history. The active one falls back to Default. */
  remove(provider: AccountProvider, id: string): void {
    if (id === DEFAULT_ACCOUNT) throw new AccountError("The Default account can't be removed.");
    const all = this.stored(provider);
    const gone = all.find((a) => a.id === id);
    if (!gone) throw new AccountError('That account no longer exists.');
    this.save(provider, all.filter((a) => a.id !== id));
    if (this.activeId(provider) === id) this.backend.setSetting(`activeAccount.${provider}`, DEFAULT_ACCOUNT);
    // The link goes first: removing the folder must never follow it into the shared chats.
    try { rmSync(join(gone.configDir, HOME_ENV[provider].shared), { force: true }); } catch { /* not there */ }
    try { if (!existsSync(join(gone.configDir, HOME_ENV[provider].shared))) rmSync(gone.configDir, { recursive: true, force: true }); } catch { /* left behind */ }
  }

  activate(provider: AccountProvider, id: string): Account {
    if (id !== DEFAULT_ACCOUNT && !this.stored(provider).some((a) => a.id === id)) throw new AccountError('That account no longer exists.');
    this.backend.setSetting(`activeAccount.${provider}`, id);
    return this.list(provider).find((a) => a.id === id)!;
  }

  /** What the provider's processes need to use the active account (nothing for Default). */
  env(provider: AccountProvider): Record<string, string> {
    const dir = this.configDir(provider);
    return dir ? { [HOME_ENV[provider].env]: dir } : {};
  }

  /** The active account's config folder (the provider's own for Default). */
  home(provider: AccountProvider): string {
    return this.configDir(provider) ?? this.providerHome[provider];
  }

  private configDir(provider: AccountProvider): string | null {
    const id = this.activeId(provider);
    return this.stored(provider).find((a) => a.id === id)?.configDir ?? null;
  }

  private activeId(provider: AccountProvider): string {
    const id = this.backend.getSetting(`activeAccount.${provider}`);
    return id && (id === DEFAULT_ACCOUNT || this.stored(provider).some((a) => a.id === id)) ? id : DEFAULT_ACCOUNT;
  }

  private validName(provider: AccountProvider, name: string, except?: string): string {
    const clean = name.trim();
    if (clean === '' || clean.length > 40) throw new AccountError('Name the account in 1 to 40 characters.');
    if (this.list(provider).some((a) => a.id !== except && a.name.toLowerCase() === clean.toLowerCase())) throw new AccountError('Another account already has that name.');
    return clean;
  }

  private stored(provider: AccountProvider): Stored[] {
    try {
      const v: unknown = JSON.parse(this.backend.getSetting(`accounts.${provider}`) ?? '[]');
      return Array.isArray(v) ? v.filter((a): a is Stored => typeof a?.id === 'string' && typeof a?.name === 'string' && typeof a?.configDir === 'string') : [];
    } catch { return []; }
  }

  private save(provider: AccountProvider, all: Stored[]): void {
    this.backend.setSetting(`accounts.${provider}`, JSON.stringify(all));
  }
}

/** Switching would stop chats that are running on the current account. */
export class AccountBusyError extends Error {}

/** What the API calls: the account store plus what has to follow a switch (adapters, usage, the page). */
export class AccountService {
  private accounts: AccountStore;
  private runningOn: (provider: AccountProvider) => boolean;
  private switched: (provider: AccountProvider) => void;
  private emit: (e: { type: 'accounts.updated'; provider: AccountProvider; accounts: Account[] }) => void;

  constructor(opts: {
    accounts: AccountStore;
    /** A chat of this provider is running in the app right now. */
    runningOn: (provider: AccountProvider) => boolean;
    /** Tells the adapter, usage and connection check that another account is active. */
    switched: (provider: AccountProvider) => void;
    emit: (e: { type: 'accounts.updated'; provider: AccountProvider; accounts: Account[] }) => void;
  }) {
    this.accounts = opts.accounts;
    this.runningOn = opts.runningOn;
    this.switched = opts.switched;
    this.emit = opts.emit;
  }

  all(): Record<AccountProvider, Account[]> {
    return { claude: this.accounts.list('claude'), codex: this.accounts.list('codex') };
  }

  /** A new account becomes the active one, so the Sign in that follows signs in to it. */
  add(provider: AccountProvider, name: string): Account[] {
    this.guard(provider);
    const a = this.accounts.add(provider, name);
    this.accounts.activate(provider, a.id);
    return this.changed(provider, true);
  }

  rename(provider: AccountProvider, id: string, name: string): Account[] {
    this.accounts.rename(provider, id, name);
    return this.changed(provider, false);
  }

  activate(provider: AccountProvider, id: string): Account[] {
    if (this.accounts.list(provider).find((a) => a.id === id)?.active) return this.accounts.list(provider);
    this.guard(provider);
    this.accounts.activate(provider, id);
    return this.changed(provider, true);
  }

  remove(provider: AccountProvider, id: string): Account[] {
    const wasActive = this.accounts.list(provider).find((a) => a.id === id)?.active ?? false;
    if (wasActive) this.guard(provider);
    this.accounts.remove(provider, id);
    return this.changed(provider, wasActive);
  }

  /** Codex runs every chat in one helper process signed in to one account: it can't switch under a running chat. */
  private guard(provider: AccountProvider): void {
    if (provider === 'codex' && this.runningOn(provider)) throw new AccountBusyError('A Codex chat is running. Switch accounts when it finishes.');
  }

  private changed(provider: AccountProvider, switched: boolean): Account[] {
    if (switched) this.switched(provider);
    const accounts = this.accounts.list(provider);
    this.emit({ type: 'accounts.updated', provider, accounts });
    return accounts;
  }
}

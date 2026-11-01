import type { AdapterEvent, Effort, ModelOption, ProviderId, UsageReading } from '@agent-kanban/shared';

export interface PingResult {
  ok: boolean;
  signedIn: boolean | null;
  message?: string;
  /** The adapter stopped restarting the provider on its own; only a manual check tries again. */
  gaveUp?: boolean;
}

/** Per-turn settings: the effort to map, and extra instructions for the agent (e.g. ask for `Next:` lines). */
export interface TurnOptions { effort?: Effort; instructions?: string }

export interface ProviderAdapter {
  id: ProviderId;
  /** `effort: false` means the adapter ignores TurnOptions.effort. */
  capabilities: { effort: boolean };
  startChat(input: { cwd: string; prompt: string; model?: string } & TurnOptions): Promise<{ sessionRef: string }>;
  sendMessage(sessionRef: string, text: string, opts?: TurnOptions): Promise<void>;
  respondToRequest(sessionRef: string, requestId: string, decision: 'allow' | 'deny' | { reply: string }): Promise<void>;
  stop(sessionRef: string): Promise<void>;
  resume(sessionRef: string, cwd: string): Promise<void>;
  onEvent(listener: (e: AdapterEvent) => void): () => void;
  readUsage(): Promise<UsageReading>;
  /** The models the account can pick for a new chat. Rejects on failure. */
  listModels(): Promise<ModelOption[]>;
  /**
   * Is the provider process alive and signed in? Never rejects. `manual: true` (a user-requested check) skips
   * any automatic-restart backoff; periodic pings leave it off.
   */
  ping(opts?: { manual?: boolean }): Promise<PingResult>;
  /** After the provider's binary was updated: replace the long-lived helper process if nothing is running on it. */
  restartIfIdle?(): Promise<boolean>;
  /** True when no chat is running on this adapter (so it can be replaced without cutting anything off). */
  isIdle?(): boolean;
  /** The provider's own version when it reports one over its protocol (Antigravity: ACP agentInfo.version). */
  agentVersion?(): Promise<string | null>;
  dispose(): Promise<void>;
}

import type { AdapterEvent, ProviderId, UsageReading } from '@agent-kanban/shared';

export interface PingResult { ok: boolean; signedIn: boolean | null; message?: string }

export interface ProviderAdapter {
  id: ProviderId;
  startChat(input: { cwd: string; prompt: string; model?: string }): Promise<{ sessionRef: string }>;
  sendMessage(sessionRef: string, text: string): Promise<void>;
  respondToRequest(sessionRef: string, requestId: string, decision: 'allow' | 'deny' | { reply: string }): Promise<void>;
  stop(sessionRef: string): Promise<void>;
  resume(sessionRef: string, cwd: string): Promise<void>;
  onEvent(listener: (e: AdapterEvent) => void): () => void;
  readUsage(): Promise<UsageReading>;
  /**
   * Is the provider process alive and signed in? Never rejects. `manual: true` (a user-requested check) skips
   * any automatic-restart backoff; periodic pings leave it off.
   */
  ping(opts?: { manual?: boolean }): Promise<PingResult>;
  dispose(): Promise<void>;
}

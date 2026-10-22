import type { AdapterEvent, ProviderId, UsageReading } from '@agent-kanban/shared';

export interface ProviderAdapter {
  id: ProviderId;
  startChat(input: { cwd: string; prompt: string; model?: string }): Promise<{ sessionRef: string }>;
  sendMessage(sessionRef: string, text: string): Promise<void>;
  respondToRequest(sessionRef: string, requestId: string, decision: 'allow' | 'deny' | { reply: string }): Promise<void>;
  stop(sessionRef: string): Promise<void>;
  resume(sessionRef: string, cwd: string): Promise<void>;
  onEvent(listener: (e: AdapterEvent) => void): () => void;
  readUsage(): Promise<UsageReading>;
  dispose(): Promise<void>;
}

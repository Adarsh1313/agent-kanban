import type { ProviderId } from '@agent-kanban/shared';

export const PROVIDERS: Record<ProviderId, { name: string; file: string }> = {
  claude: { name: 'Claude Code', file: 'claude-color.svg' },
  codex: { name: 'Codex', file: 'codex-color.svg' },
  antigravity: { name: 'Antigravity', file: 'antigravity-color.svg' },
};
export const PROVIDER_IDS: ProviderId[] = ['claude', 'codex', 'antigravity'];
export const providerName = (id: ProviderId): string => PROVIDERS[id].name;

/** Decorative by default (the name is always written next to it); pass `alt` when it stands alone. */
export function ProviderLogo({ id, size, alt = '' }: { id: ProviderId; size?: 'sm' | 'lg'; alt?: string }) {
  return <img className={['logo', size].filter(Boolean).join(' ')} src={`/providers/${PROVIDERS[id].file}`} alt={alt} width={16} height={16} />;
}

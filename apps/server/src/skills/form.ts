import type { ProviderId } from '@agent-kanban/shared';

/**
 * A message that starts with `/name` for a known skill, in the provider's own form: `/name` for Claude, `$name`
 * for Codex, and for Antigravity a call to the skill as a workflow. Anything else is sent unchanged.
 */
export function skillForm(provider: ProviderId, text: string, skills: string[]): string {
  const m = /^\/([\w.:-]+)(?=\s|$)([\s\S]*)$/.exec(text);
  if (!m || !skills.includes(m[1]!)) return text;
  const [, name, rest] = m;
  if (provider === 'claude') return text;
  if (provider === 'codex') return `$${name}${rest}`;
  return `Run the "${name}" workflow from your skills.${rest.trim() ? `\n\n${rest.trim()}` : ''}`;
}

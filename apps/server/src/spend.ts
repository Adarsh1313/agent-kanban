// What a turn on the user's own API key cost (#43). Claude reports dollars itself; Codex reports tokens,
// priced here with a small table (US dollars per million tokens, list prices). Unknown models use the
// default row, so a cap still stops a chat even when the estimate is a little off.
import type { TokenCount } from '@agent-kanban/shared';

interface Price { input: number; cachedInput: number; output: number }

const DEFAULT: Price = { input: 1.25, cachedInput: 0.125, output: 10 };
/** Matched by prefix, longest first. */
const PRICES: [string, Price][] = [
  ['gpt-5-codex-mini', { input: 0.25, cachedInput: 0.025, output: 2 }],
  ['gpt-5-mini', { input: 0.25, cachedInput: 0.025, output: 2 }],
  ['gpt-5-nano', { input: 0.05, cachedInput: 0.005, output: 0.4 }],
  ['gpt-5', DEFAULT],
];

export function priceTokens(t: TokenCount): number {
  const model = (t.model ?? '').toLowerCase();
  const price = PRICES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? DEFAULT;
  // Cached input is part of input in Codex's counts: charge it at the cached rate only.
  const fresh = Math.max(0, t.input - t.cachedInput);
  return (fresh * price.input + t.cachedInput * price.cachedInput + t.output * price.output) / 1_000_000;
}

/** The dollars a cost event stands for. */
export function costUsd(e: { usd?: number; tokens?: TokenCount }): number {
  if (typeof e.usd === 'number' && Number.isFinite(e.usd)) return Math.max(0, e.usd);
  return e.tokens ? priceTokens(e.tokens) : 0;
}

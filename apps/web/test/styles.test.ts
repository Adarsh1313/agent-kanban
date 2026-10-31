import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sheets = ['../../../design/components.css', '../../../design/views.css', '../src/styles/app.css'];
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('global stylesheets', () => {
  it('never style a bare .agent: chat replies are .msg.agent and would inherit it (#3)', () => {
    for (const rel of sheets) {
      const bare = read(rel).split('\n').filter((line) => /(^|[\s,>+~(])\.agent(?![-\w])/.test(line) && !/\.msg\.agent/.test(line));
      expect(bare, rel).toEqual([]);
    }
  });

  it('menus open above the chat panel, so its "…" menu shows (#36)', () => {
    const css = read('../../../design/components.css');
    const z = (sel: string) => Number(new RegExp(`^\\${sel} \\{[^}]*?z-index: (\\d+)`, 'm').exec(css)?.[1]);
    expect(z('.popover')).toBeGreaterThan(z('.panel'));
  });
});

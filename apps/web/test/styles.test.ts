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
});

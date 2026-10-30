import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown, safeHref } from '../src/ui/chat/Markdown.tsx';

afterEach(() => cleanup());
const html = (text: string) => render(<div data-testid="m"><Markdown text={text} /></div>).container.firstElementChild!;

describe('Markdown in agent replies (#4)', () => {
  it('renders the replies seen in the click-through: bold, inline code and a file link', () => {
    const a = html('`node --version` printed **v25.6.0**.');
    expect(a.querySelector('code.md-inline')?.textContent).toBe('node --version');
    expect(a.querySelector('strong')?.textContent).toBe('v25.6.0');
    expect(a.textContent).toBe('node --version printed v25.6.0.');

    const b = html('Created [`agy.txt`](file:///C:/work/agy.txt) containing `ok`.');
    expect(b.querySelector('a')).toBeNull(); // file:// links never become clickable
    expect(b.querySelector('.md-link-text code')?.textContent).toBe('agy.txt');
    expect(b.textContent).toBe('Created agy.txt containing ok.');
  });

  it('paragraphs, line breaks, headings, lists, quotes and fenced code', () => {
    const el = html('# Plan\n\nFirst line\nsecond line\n\n- one\n- *two*\n\n3. three\n4. four\n\n> quoted\n\n```ts\nconst a = **1**;\n```');
    expect(el.querySelector('.md-h1')?.textContent).toBe('Plan');
    expect(el.querySelector('.md-p')!.querySelectorAll('br').length).toBe(1);
    expect([...el.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect(el.querySelector('ul em')?.textContent).toBe('two');
    expect(el.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(el.querySelector('.md-quote')?.textContent).toBe('quoted');
    // Code is literal: no bold inside it.
    expect(el.querySelector('pre code')?.textContent).toBe('const a = **1**;');
    expect(el.querySelector('pre strong')).toBeNull();
  });

  it('never turns text into HTML, and only http(s) links are clickable', () => {
    const el = html('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://example.com/a?b=1)');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = el.querySelectorAll('a');
    expect(links.length).toBe(1);
    expect(links[0]!.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });

  it('plain text and snake_case stay as they are; an unfinished fence (still streaming) shows as code', () => {
    expect(html('Use my_var_name and 2 * 3 * 4.').textContent).toBe('Use my_var_name and 2 * 3 * 4.');
    expect(html('Use my_var_name').querySelector('em')).toBeNull();
    expect(html('```\npartial').querySelector('pre code')?.textContent).toBe('partial');
  });
});

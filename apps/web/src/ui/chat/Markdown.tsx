import { Fragment, type ReactNode } from 'react';

/**
 * A small, safe markdown renderer for agent replies (#4): paragraphs, headings, bullet and numbered lists, fenced code,
 * block quotes, and inline code, bold, italics and links. It builds React elements only (never HTML strings), so
 * nothing in a reply can inject markup. Links open only for http(s); any other link (file://, javascript:, …) shows
 * its text.
 */
export function Markdown({ text }: { text: string }) {
  return <>{blocks(text.replace(/\r\n?/g, '\n'))}</>;
}

type Block =
  | { kind: 'p' | 'quote'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'ul' | 'ol'; items: string[]; start: number };

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBER = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function parse(text: string): Block[] {
  const lines = text.split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++; // the closing fence (or the end of a reply still streaming)
      out.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) { out.push({ kind: 'h', level: h[1]!.length, text: h[2]! }); i++; continue; }
    if (BULLET.test(line) || NUMBER.test(line)) {
      const ordered = !BULLET.test(line);
      const re = ordered ? NUMBER : BULLET;
      const start = ordered ? Number(NUMBER.exec(line)![1]) : 1;
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim()) {
        const m = re.exec(lines[i]!);
        if (m) items.push(ordered ? m[2]! : m[1]!);
        else if (items.length > 0 && /^\s+\S/.test(lines[i]!)) items[items.length - 1] += ' ' + lines[i]!.trim(); // wrapped item
        else break;
        i++;
      }
      out.push({ kind: ordered ? 'ol' : 'ul', items, start });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) quoted.push(QUOTE.exec(lines[i++]!)![1]!);
      out.push({ kind: 'quote', lines: quoted });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !FENCE.test(lines[i]!) && !HEADING.test(lines[i]!) && !BULLET.test(lines[i]!) && !NUMBER.test(lines[i]!) && !QUOTE.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    out.push({ kind: 'p', lines: para });
  }
  return out;
}

function blocks(text: string): ReactNode[] {
  return parse(text).map((b, k) => {
    switch (b.kind) {
      case 'code': return <pre className="md-code" key={k}><code data-lang={b.lang || undefined}>{b.text}</code></pre>;
      case 'h': return <p className={`md-h md-h${Math.min(b.level, 3)}`} key={k}>{inline(b.text)}</p>;
      case 'ul': return <ul className="md-list" key={k}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>;
      case 'ol': return <ol className="md-list" key={k} start={b.start === 1 ? undefined : b.start}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>;
      case 'quote': return <blockquote className="md-quote" key={k}>{lineBreaks(b.lines)}</blockquote>;
      case 'p': return <p className="md-p" key={k}>{lineBreaks(b.lines)}</p>;
    }
  });
}

const lineBreaks = (lines: string[]) => lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>);

// Inline code first (its content is literal), then links, bold and italics.
const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*(?=\S)([\s\S]+?)\*\*|__(?=\S)([\s\S]+?)__|\*(?=\S)([^*\n]+?)\*|(?<![\w])_(?=\S)([^_\n]+?)_(?![\w])/g;

export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) out.push(<code className="md-inline" key={k++}>{m[2].trim() || m[2]}</code>);
    else if (m[3] !== undefined) {
      const href = safeHref(m[4]!);
      out.push(href
        ? <a key={k++} href={href} target="_blank" rel="noopener noreferrer">{inline(m[3])}</a>
        : <span key={k++} className="md-link-text">{inline(m[3])}</span>);
    } else if (m[5] !== undefined || m[6] !== undefined) out.push(<strong key={k++}>{inline((m[5] ?? m[6])!)}</strong>);
    else out.push(<em key={k++}>{inline((m[7] ?? m[8])!)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

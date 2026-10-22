import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Yields parsed JSON objects from a JSONL file (read-only); bad lines are skipped. Unreadable file yields nothing. */
export async function* readJsonl(path: string): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(path, { encoding: 'utf8', flags: 'r' });
  stream.on('error', () => {});
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (v && typeof v === 'object') yield v as Record<string, unknown>;
      } catch { /* skip corrupt line */ }
    }
  } catch { /* unreadable file */ } finally {
    rl.close();
    stream.destroy();
  }
}

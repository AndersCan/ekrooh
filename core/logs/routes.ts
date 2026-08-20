import {
  collectRequestBody,
  LoopbackServer,
} from '../server/static-file-server';
import { LogLevel, LogSource, LogStore } from './types';

type LogBatchEntry = {
  level?: LogLevel;
  tag?: string;
  message: string;
};

type LogIngestPayload = {
  /** Ingest source discriminator; defaults to `web`. */
  source?: LogSource;
  entries: LogBatchEntry[];
};

function queryParams(url: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const query = (url ?? '').split('?')[1];
  if (!query) return out;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = decodeURIComponent(pair.slice(0, eq));
    const value = decodeURIComponent(pair.slice(eq + 1));
    out[key] = value;
  }
  return out;
}

function formatText(e: {
  ts: number;
  level: LogLevel;
  source: LogSource;
  tag?: string;
  message: string;
}): string {
  const tag = e.tag ? `[${e.tag}] ` : '';
  return `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()} ${e.source} ${tag}${e.message}`;
}

/** Registers the loopback log routes on the unified server. They inherit the
 * server's auth gate and single-server rule for free:
 *
 * - `GET /logs?tail=&level=&source=&format=jsonl|text` — bulk read-back,
 *   deliberately off the framed invoke so there is no `MAX_HEADER_BYTES`
 *   ceiling.
 * - `POST /logs` — ingest for web/browser log batches (`{ source, entries }`).
 */
export function registerLogRoutes(
  server: LoopbackServer,
  store: LogStore,
): void {
  server.registerRoute('GET', '/logs', (req, res) => {
    const params = queryParams(req.url);
    const tail = params.tail === undefined ? undefined : Number(params.tail);
    const level = (params.level as LogLevel) || undefined;
    const source = (params.source as LogSource) || undefined;
    const entries = store.view({
      tail: tail !== undefined && Number.isFinite(tail) ? tail : undefined,
      level,
      source,
    });

    const format = params.format === 'jsonl' ? 'jsonl' : 'text';
    res.writeHead(200, {
      'Content-Type':
        format === 'jsonl' ? 'application/x-ndjson' : 'text/plain',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    if (format === 'jsonl') {
      const lines = entries.map((e) => JSON.stringify(e)).join('\n');
      res.end(lines.length > 0 ? `${lines}\n` : '');
    } else {
      const lines = entries.map(formatText).join('\n');
      res.end(lines.length > 0 ? `${lines}\n` : '');
    }
  });

  server.registerRoute('POST', '/logs', (req, res) => {
    void collectRequestBody(req).then((body) => {
      let parsed: LogIngestPayload;
      try {
        parsed = JSON.parse(body) as LogIngestPayload;
      } catch {
        res.writeHead(400, {
          'Content-Type': 'text/plain',
          'Referrer-Policy': 'no-referrer',
        });
        res.end('Bad request');
        return;
      }
      const source: LogSource = parsed.source === 'backend' ? 'backend' : 'web';
      const batch = Array.isArray(parsed.entries) ? parsed.entries : [];
      let accepted = 0;
      for (const raw of batch) {
        if (!raw || typeof raw.message !== 'string') continue;
        store.append({
          ts: Date.now(),
          level: raw.level ?? 'info',
          source,
          tag: raw.tag,
          message: raw.message,
        });
        accepted++;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ accepted }));
    });
  });
}

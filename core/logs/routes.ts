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
  /** Ignored: every HTTP ingest is recorded as `web`. */
  source?: unknown;
  entries?: unknown;
};

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Parses the query string, or returns null when an escape is malformed. */
function queryParams(url: string | undefined): Record<string, string> | null {
  const out: Record<string, string> = {};
  const query = (url ?? '').split('?')[1];
  if (!query) return out;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    try {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(
        pair.slice(eq + 1),
      );
    } catch {
      return null;
    }
  }
  return out;
}

function isLogLevel(value: unknown): value is LogLevel {
  return LOG_LEVELS.includes(value as LogLevel);
}

/** Longest ingested message and tag, in UTF-16 code units. The ring holds a
 * fixed number of entries, so this is what bounds its memory: without it a
 * page could pin capacity × 1 MiB in the worklet. */
export const MAX_INGEST_MESSAGE_CHARS = 8 * 1024;
export const MAX_INGEST_TAG_CHARS = 64;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** One entry per line: a line break inside a message would let a page write a
 * line that reads as a backend diagnostic. */
function oneLine(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function formatText(e: {
  ts: number;
  level: LogLevel;
  source: LogSource;
  tag?: string;
  message: string;
}): string {
  const tag = e.tag ? `[${oneLine(e.tag)}] ` : '';
  return `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()} ${e.source} ${tag}${oneLine(e.message)}`;
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
    if (params === null) {
      res.writeHead(400, {
        'Content-Type': 'text/plain',
        'Referrer-Policy': 'no-referrer',
      });
      res.end('Bad request');
      return;
    }
    const tail = params.tail === undefined ? undefined : Number(params.tail);
    const level = isLogLevel(params.level) ? params.level : undefined;
    const source =
      params.source === 'web' || params.source === 'backend'
        ? params.source
        : undefined;
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
    collectRequestBody(req, 1024 * 1024)
      .then(
        (body) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }
          if (typeof parsed !== 'object' || parsed === null) {
            res.writeHead(400, {
              'Content-Type': 'text/plain',
              'Referrer-Policy': 'no-referrer',
            });
            res.end('Bad request');
            return;
          }
          // Everything that arrives over HTTP is page output. `backend` entries
          // come only from the worklet's own console capture, so a page cannot
          // write lines that read as backend diagnostics.
          const source: LogSource = 'web';
          const entries = (parsed as LogIngestPayload).entries;
          const batch: unknown[] = Array.isArray(entries) ? entries : [];
          let accepted = 0;
          for (const item of batch) {
            if (typeof item !== 'object' || item === null) continue;
            const raw = item as Partial<LogBatchEntry>;
            if (typeof raw.message !== 'string') continue;
            store.append({
              ts: Date.now(),
              level: isLogLevel(raw.level) ? raw.level : 'info',
              source,
              tag:
                typeof raw.tag === 'string'
                  ? truncate(raw.tag, MAX_INGEST_TAG_CHARS)
                  : undefined,
              message: truncate(raw.message, MAX_INGEST_MESSAGE_CHARS),
            });
            accepted++;
          }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ accepted }));
        },
        (err: unknown) => {
          // An oversized ingest is a 413, never an OOM DoS — drop the batch and
          // move on (the worklet is single-tenant, so nothing else can be hurt).
          const message = err instanceof Error ? err.message : String(err);
          console.error('Discarding oversized /logs batch:', message);
          res.writeHead(413, {
            'Content-Type': 'text/plain',
            'Referrer-Policy': 'no-referrer',
          });
          res.end('Request Entity Too Large');
        },
      )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[loopback] POST /logs failed: ${message}`);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(500, {
          'Content-Type': 'text/plain',
          'Referrer-Policy': 'no-referrer',
        });
        res.end('Internal Server Error');
      });
  });
}

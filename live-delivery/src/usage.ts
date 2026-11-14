/** Best-effort transcript token estimates at hook boundaries, never billing data. */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { atomicJson, sessionKeyFor, type CdConfig } from './config.js';
import { getActiveId, readState, sessionDir } from './state.js';

type Counts = { input: number; output: number; cacheRead: number; cacheCreate: number };
export type CdUsage = Counts & {
  scanOffset: number;
  path: string;
  ts: number;
  seen: Record<string, Counts>;
  previous?: Counts;
};
const zero = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
const keys = ['input', 'output', 'cacheRead', 'cacheCreate'] as const;
function usageFile(workspaceDir: string, id: string): string {
  return path.join(sessionDir(workspaceDir, id), 'usage.json');
}
export function readUsage(workspaceDir: string, id: string): CdUsage | null {
  try {
    return JSON.parse(readFileSync(usageFile(workspaceDir, id), 'utf8')) as CdUsage;
  } catch {
    return null;
  }
}

// Claude may repeat a message's usage across content blocks; keep the greatest
// observed counts for each message ID. Codex emits cumulative token_count
// records, sometimes repeatedly; add only their deltas. Exclude pre-task turns.
export function updateUsageFromTranscript(cfg: CdConfig, transcriptPath: string | undefined): void {
  if (!transcriptPath) return;
  const id = getActiveId(cfg.workspaceDir, sessionKeyFor(cfg));
  const state = id && readState(cfg.workspaceDir, id);
  if (!id || !state) return;
  let fd: number | undefined;
  try {
    const size = statSync(transcriptPath).size;
    let cur = readUsage(cfg.workspaceDir, id);
    if (!cur || cur.path !== transcriptPath || size < cur.scanOffset) {
      cur = { ...zero(), scanOffset: 0, path: transcriptPath, ts: 0, seen: {} };
    }
    if (size <= cur.scanOffset) return;
    fd = openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(size - cur.scanOffset);
    const count = readSync(fd, buf, 0, buf.length, cur.scanOffset);
    const lastNl = buf.subarray(0, count).lastIndexOf(10);
    if (lastNl < 0) return;
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      try {
        const rec = JSON.parse(line);
        const ts = Date.parse(rec.timestamp);
        if (!Number.isFinite(ts)) continue;
        if (cfg.harness === 'codex') {
          const u =
            rec.type === 'event_msg' &&
            rec.payload?.type === 'token_count' &&
            rec.payload.info?.total_token_usage;
          if (!u) continue;
          const next: Counts = {
            input: Math.max(
              0,
              (u.input_tokens ?? 0) -
                (u.cached_input_tokens ?? 0) -
                (u.cache_write_input_tokens ?? 0),
            ),
            output: u.output_tokens ?? 0,
            cacheRead: u.cached_input_tokens ?? 0,
            cacheCreate: u.cache_write_input_tokens ?? 0,
          };
          if (ts >= state.startedTs)
            for (const k of keys) cur[k] += Math.max(0, next[k] - (cur.previous?.[k] ?? 0));
          cur.previous = next;
        } else {
          const u = rec.type === 'assistant' && rec.message?.usage;
          if (!u || !rec.message.id || ts < state.startedTs) continue;
          const next: Counts = {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheCreate: u.cache_creation_input_tokens ?? 0,
          };
          const prev = cur.seen[rec.message.id] ?? zero();
          for (const k of keys) {
            next[k] = Math.max(next[k], prev[k]);
            cur[k] += next[k] - prev[k];
          }
          cur.seen[rec.message.id] = next;
        }
      } catch {
        /* Ignore malformed/unsupported records. */
      }
    }
    cur.scanOffset += lastNl + 1;
    cur.ts = Date.now();
    atomicJson(usageFile(cfg.workspaceDir, id), cur);
  } catch {
    /* Optional meter must never interfere with Stop or task routing. */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

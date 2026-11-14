import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseDurationSec } from './engine.js';
import { configuredModel } from './model.js';
import { requireSupportedPlatform } from './process.js';
import { accessLink } from './access.js';
import { cdRootDir } from './state.js';

declare const QWEN_LD_HARNESS: 'claude-code' | 'codex';
export type Harness = 'claude-code' | 'codex';
export const DEFAULT_BASE_PATH = '/live-delivery';
export type CdConfig = {
  harness: Harness;
  workspaceDir: string;
  instance: string;
  sessionKey?: string;
  port: number;
  basePath: string;
  deliverEverySec: number;
  timeBudgetSec: number;
  minWorkingSec: number;
  minReleases: number;
  model: string;
  channels: boolean;
  bindHost?: string;
  accessToken?: string;
  dashboardFile?: string;
  openBrowser?: 'auto' | 'never' | 'always';
  readOnly?: boolean;
  requirePlanApproval?: boolean;
  planMode?: 'fixed' | 'rolling';
};

export function atomicJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

// Hooks and stdio MCP children share the CLI ancestor, even when a shell or
// package launcher sits between them. Never use a project-global active slot.
// An explicit instance is useful for embedded hosts and deterministic tests.
function ownerInstance(harness: Harness): string {
  if (process.env.QWEN_LD_INSTANCE_ID) return process.env.QWEN_LD_INSTANCE_ID;
  let pid = process.ppid;
  for (let i = 0; pid > 1 && i < 16; i++) {
    try {
      const row = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const match = /^(\d+)\s+(.+)$/.exec(row);
      if (!match) break;
      const name = path.basename(match[2]);
      if (
        harness === 'claude-code' ? /^claude(?:$|[-.])/.test(name) : /^codex(?:$|[-.])/.test(name)
      ) {
        const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
          encoding: 'utf8',
          timeout: 2000,
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return `pid-${pid}-${started}`;
      }
      pid = Number(match[1]);
    } catch {
      break;
    }
  }
  return `parent-${process.ppid}`;
}

export function loadConfig(workspace?: string): CdConfig {
  requireSupportedPlatform();
  const harness = typeof QWEN_LD_HARNESS === 'undefined' ? 'codex' : QWEN_LD_HARNESS;
  const env = process.env;
  const port = Number(env.QWEN_LD_PORT ?? (harness === 'claude-code' ? 18790 : 18791));
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('QWEN_LD_PORT must be 0..65535.');
  const minReleases = 1;
  const basePath = '/' + (env.QWEN_LD_BASE_PATH ?? DEFAULT_BASE_PATH).replace(/^\/+|\/+$/g, '');
  if (!/^\/[a-zA-Z0-9_/-]+$/.test(basePath)) throw new Error('Invalid QWEN_LD_BASE_PATH.');
  return {
    harness,
    workspaceDir: path.resolve(
      env.QWEN_LD_WORKSPACE || workspace || env.CLAUDE_PROJECT_DIR || process.cwd(),
    ),
    instance: ownerInstance(harness),
    sessionKey: env.QWEN_LD_SESSION_KEY || undefined,
    port,
    basePath,
    dashboardFile: env.QWEN_LD_DASHBOARD_FILE || undefined,
    bindHost: env.QWEN_LD_BIND_HOST === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
    openBrowser:
      env.QWEN_LD_OPEN_BROWSER === 'never'
        ? 'never'
        : env.QWEN_LD_OPEN_BROWSER === 'always'
          ? 'always'
          : 'auto',
    deliverEverySec: 120,
    timeBudgetSec: Math.max(1, parseDurationSec(env.QWEN_LD_TIME_BUDGET, 1800)),
    minWorkingSec: 0,
    minReleases,
    requirePlanApproval: false,
    planMode: 'rolling',
    model: configuredModel(harness, env),
    channels: harness === 'claude-code' && env.QWEN_LD_CHANNELS === '1',
  };
}

function runtimeFile(cfg: CdConfig, suffix: string): string {
  const hash = createHash('sha256').update(cfg.instance).digest('hex').slice(0, 20);
  return path.join(
    cdRootDir(cfg.workspaceDir),
    '_runtime',
    `${cfg.harness}-${hash}.${suffix}.json`,
  );
}
type Binding = { sessionKey: string; model?: string; conflicting?: boolean };
// Codex's MCP loader can resolve cwd relative to the plugin, not the user's
// project. Hooks supply the authoritative workspace, including `codex --cd`.
// Keep only a routing pointer outside the workspace; task data stays in .live-delivery.
function hostFile(cfg: CdConfig): string {
  const dir = path.join(
    os.tmpdir(),
    `live-delivery-host-${process.getuid?.() ?? os.userInfo().username}`,
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256').update(cfg.instance).digest('hex').slice(0, 20);
  return path.join(dir, `${cfg.harness}-${hash}.json`);
}
export function configForServer(seed: CdConfig): CdConfig | null {
  if (process.env.QWEN_LD_WORKSPACE) return seed;
  const host = readJson<Binding & { workspaceDir: string }>(hostFile(seed));
  if (host?.conflicting)
    throw new Error(
      'CD session binding is ambiguous. Use a separate CLI process for each conversation.',
    );
  return host?.workspaceDir ? loadConfig(host.workspaceDir) : null;
}
export function bindSession(cfg: CdConfig, input: Record<string, unknown>): void {
  if (typeof input.session_id !== 'string' || !input.session_id) return;
  const sessionKey = `${cfg.harness}:${input.session_id}`;
  const file = runtimeFile(cfg, 'binding');
  const prev = readJson<Binding>(file);
  // A shared host with simultaneous conversations cannot be identified safely
  // by PID alone. Refuse ambiguous routing rather than touching another task.
  const reset = input.hook_event_name === 'SessionStart' && input.source === 'clear';
  const previousHost = readJson<Binding>(hostFile(cfg));
  const conflicting =
    !reset &&
    (prev?.conflicting ||
      (!!prev && prev.sessionKey !== sessionKey) ||
      previousHost?.conflicting ||
      (!!previousHost && previousHost.sessionKey !== sessionKey));
  atomicJson(file, {
    sessionKey,
    model:
      typeof input.model === 'string' && input.model
        ? input.model
        : prev?.sessionKey === sessionKey
          ? prev.model
          : undefined,
    conflicting,
  } satisfies Binding);
  atomicJson(hostFile(cfg), { workspaceDir: cfg.workspaceDir, sessionKey, conflicting });
}
export function sessionKeyFor(cfg: CdConfig): string {
  const binding = readJson<Binding>(runtimeFile(cfg, 'binding'));
  // Explicit session routing still needs native model updates. Also refresh
  // after a /model change rather than only replacing the initial "unknown".
  if (!process.env.QWEN_LD_MODEL && binding?.model && !binding.conflicting)
    cfg.model = binding.model;
  if (cfg.sessionKey) return cfg.sessionKey;
  const host = readJson<Binding>(hostFile(cfg));
  if (!binding || binding.conflicting || host?.conflicting) {
    throw new Error(
      binding?.conflicting || host?.conflicting
        ? 'CD session binding is ambiguous. Use a separate CLI process for each conversation, or set QWEN_LD_SESSION_KEY explicitly for an embedded host.'
        : 'No CD session binding. Enable the plugin SessionStart/UserPromptSubmit hooks and start a new session.',
    );
  }
  return binding.sessionKey;
}
export function persistConfig(cfg: CdConfig): void {
  atomicJson(runtimeFile(cfg, 'config'), cfg);
}
export function loadConfigForHook(input: Record<string, unknown>): CdConfig {
  const cfg = loadConfig(typeof input.cwd === 'string' ? input.cwd : undefined);
  bindSession(cfg, input);
  const saved = readJson<CdConfig>(runtimeFile(cfg, 'config'));
  const sessionKey =
    cfg.sessionKey ||
    (typeof input.session_id === 'string' ? `${cfg.harness}:${input.session_id}` : undefined);
  const model =
    process.env.QWEN_LD_MODEL ||
    (typeof input.model === 'string' && input.model) ||
    saved?.model ||
    cfg.model;
  return { ...cfg, ...saved, workspaceDir: cfg.workspaceDir, sessionKey, model };
}
export function siteBaseUrl(cfg: CdConfig): string {
  return `http://127.0.0.1:${cfg.port}${cfg.basePath}`;
}
export function sessionUrl(cfg: CdConfig, id: string): string {
  return accessLink(`${siteBaseUrl(cfg)}/?s=${encodeURIComponent(id)}`, cfg.accessToken);
}

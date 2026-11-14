import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  providerEnvNames,
  configureProviderEnv,
  forwardedEnvNames,
  requireProviderEnv,
} from '../.test-build/provider-env.js';

test('provider forwarding discovers arbitrary case-sensitive names without storing credentials', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-provider-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    model_provider: 'custom',
    model_providers: {
      custom: {
        env_key: 'custom_model_token',
        env_http_headers: { 'X-Tenant': 'CUSTOM_TENANT', 'X-Invalid': 'not a variable' },
      },
    },
    profiles: { another: { model_providers: { other: { env_key: 'OTHER_TOKEN' } } } },
  };
  const names = providerEnvNames(config);
  assert.deepEqual(names, ['CUSTOM_TENANT', 'OTHER_TOKEN', 'custom_model_token']);
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'live-delivery': { env_vars: ['CODEX_HOME'] } } }),
  );
  configureProviderEnv(root, names);
  const first = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
  configureProviderEnv(root, names);
  assert.equal(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'), first);
  assert.deepEqual(forwardedEnvNames(root), ['CODEX_HOME', ...names]);
  assert.throws(
    () => requireProviderEnv(config, { CUSTOM_MODEL_TOKEN: 'wrong case' }),
    /unavailable/,
  );
  requireProviderEnv(config, { custom_model_token: 'synthetic-value-not-a-secret' });
  assert.ok(!first.includes('synthetic-value-not-a-secret'));
});

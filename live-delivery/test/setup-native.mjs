// No model requests, real credentials, or writes to the user's Codex home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { NativeRpc } from '../.test-build/native-rpc.js';
import { configurePluginHooks } from '../.test-build/hook-trust.js';
const root = process.env.QWEN_LD_TEST_PACKAGE
  ? path.resolve(process.env.QWEN_LD_TEST_PACKAGE)
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-setup-native-'));
const home = path.join(temp, 'home'),
  workspace = path.join(temp, 'workspace');
fs.mkdirSync(home);
fs.mkdirSync(workspace);
const env = {
  PATH: process.env.PATH,
  CODEX_HOME: home,
  ...(process.env.CODEX_BIN ? { CODEX_BIN: process.env.CODEX_BIN } : {}),
};
const config = path.join(home, 'config.toml');
fs.writeFileSync(
  config,
  '# Existing preferences stay intact\nmodel = "fixture-model"\nsandbox_mode = "workspace-write"\napproval_policy = "on-request"\n[features]\nhooks = false\n[hooks.state."unrelated-hook"]\nenabled = false\ntrusted_hash = "unrelated-fixture-hash"\n',
);
const auth = path.join(home, 'auth.json');
fs.writeFileSync(auth, '{"fixture":"NOT_A_CREDENTIAL"}\n');
const run = (args) => {
  const r = spawnSync('sh', [path.join(root, 'install.sh'), ...args, '--workspace', workspace], {
    env,
    cwd: workspace,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
};
try {
  run(['--yes', '--install-only']);
  let installedRoot;
  const rpc = new NativeRpc(env, workspace, process.env.CODEX_BIN || 'codex');
  try {
    await rpc.initialize();
    const listed = await rpc.call('skills/list', { cwds: [workspace], forceReload: true });
    const skills = listed.data.flatMap((entry) => entry.skills);
    const installedSkill = skills.find((skill) => skill.name === 'ld:install');
    assert.ok(installedSkill);
    installedRoot = path.resolve(path.dirname(installedSkill.path), '../..');
    for (const file of ['LICENSE', 'dist/server.mjs']) {
      assert.deepEqual(
        fs.readFileSync(path.join(installedRoot, file)),
        fs.readFileSync(path.join(root, file)),
        `Installed plugin must retain ${file}`,
      );
    }
    const cachedDoctor = spawnSync(
      process.execPath,
      [path.join(installedRoot, 'dist/setup.mjs'), '--doctor', '--workspace', workspace],
      { env, cwd: workspace, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(cachedDoctor.status, 0, cachedDoctor.stdout + cachedDoctor.stderr);

    for (const name of ['go', 'install'])
      assert.ok(
        skills.some(
          (skill) => skill.name === `ld:${name}` && skill.path.endsWith(`/skills/${name}/SKILL.md`),
        ),
        `Native Codex must discover ld:${name}; received names: ${skills.map((s) => s.name).join(', ')}`,
      );
  } finally {
    rpc.close();
  }
  const first = parse(fs.readFileSync(config, 'utf8'));
  assert.equal(first.model, 'fixture-model');
  assert.equal(first.sandbox_mode, 'workspace-write');
  assert.equal(first.approval_policy, 'on-request');
  assert.equal(first.features.hooks, true);
  assert.deepEqual(
    { ...first.hooks.state['unrelated-hook'] },
    { enabled: false, trusted_hash: 'unrelated-fixture-hash' },
  );
  const own = Object.entries(first.hooks.state).filter(([key]) =>
    key.startsWith('ld@live-delivery-local:'),
  );
  assert.equal(own.length, 6);
  for (const [, value] of own) {
    assert.equal(value.enabled, true);
    assert.match(value.trusted_hash, /^sha256:/);
  }
  assert.equal(fs.readFileSync(auth, 'utf8'), '{"fixture":"NOT_A_CREDENTIAL"}\n');
  const before = fs.readFileSync(config, 'utf8');
  assert.match(run(['--doctor']), /6 \/ 6 hooks/);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
  env.QWEN_LD_TASK_SANDBOX = 'danger-full-access';
  assert.match(run(['--yes', '--install-only']), /WARNING: Browser-created tasks/);
  delete env.QWEN_LD_TASK_SANDBOX;
  assert.deepEqual(parse(fs.readFileSync(config, 'utf8')), first);
  const staged = fs.readdirSync(path.join(home, 'live-delivery/packages'));
  assert.equal(staged.length, 1);
  for (const file of ['node_modules', 'src', 'test', 'docs', 'package-lock.json'])
    assert.equal(
      fs.existsSync(path.join(home, 'live-delivery/packages', staged[0], file)),
      false,
      `Installation must not copy ${file}`,
    );
  await configurePluginHooks(root, workspace, env, process.env.CODEX_BIN || 'codex', {
    exclusive: true,
  });
  const hookFile = path.join(installedRoot, 'dist/hook.mjs');
  const originalHook = fs.readFileSync(hookFile);
  try {
    fs.appendFileSync(hookFile, '\n// changed fixture hook\n');
    await assert.rejects(
      configurePluginHooks(root, workspace, env, process.env.CODEX_BIN || 'codex', {
        exclusive: true,
      }),
      /contents differ/,
    );
  } finally {
    fs.writeFileSync(hookFile, originalHook);
  }
  const extraHooks = path.join(home, 'hooks.json'),
    marker = path.join(temp, 'unreviewed-hook-ran');
  fs.writeFileSync(
    extraHooks,
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch ' + marker }] }] },
    }),
  );
  try {
    await assert.rejects(
      configurePluginHooks(root, workspace, env, process.env.CODEX_BIN || 'codex', {
        exclusive: true,
      }),
      /Additional hooks/,
    );
    assert.equal(fs.existsSync(marker), false, 'Inspecting hooks must not execute them');
    assert.equal(
      Object.keys(parse(fs.readFileSync(config, 'utf8')).hooks.state).length,
      7,
      'No extra hook trust was written',
    );
  } finally {
    fs.rmSync(extraHooks);
  }
  fs.appendFileSync(
    config,
    '\n[model_providers.custom]\nname="Local test provider"\nbase_url="http://127.0.0.1:1/v1"\nenv_key="custom_model_token"\n',
  );
  const staleProvider = spawnSync(
    process.execPath,
    [path.join(root, 'dist/setup.mjs'), '--doctor', '--workspace', workspace],
    { env, cwd: workspace, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(staleProvider.status, 1);
  assert.match(staleProvider.stderr, /does not forward/);
  run(['--yes', '--install-only']);
  assert.ok(
    JSON.parse(fs.readFileSync(path.join(installedRoot, '.mcp.json'), 'utf8')).mcpServers[
      'live-delivery'
    ].env_vars.includes('custom_model_token'),
  );
  assert.match(run(['--doctor']), /6 \/ 6 hooks/);
  fs.writeFileSync(
    config,
    fs.readFileSync(config, 'utf8').replace('hooks = true', 'hooks = false'),
  );
  const disabled = spawnSync(
    process.execPath,
    [path.join(root, 'dist/setup.mjs'), '--doctor', '--workspace', workspace],
    { env, cwd: workspace, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /disabled/);
  if (process.env.QWEN_LD_TEST_PACKAGE) {
    const marketplaceHome = path.join(temp, 'marketplace-home');
    fs.mkdirSync(marketplaceHome);
    const marketplaceEnv = { ...env, CODEX_HOME: marketplaceHome };
    for (const args of [
      ['plugin', 'marketplace', 'add', path.dirname(root), '--json'],
      ['plugin', 'add', 'ld@live-delivery-local', '--json'],
    ]) {
      const result = spawnSync(process.env.CODEX_BIN || 'codex', args, {
        env: marketplaceEnv,
        cwd: workspace,
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const marketplaceRpc = new NativeRpc(
      marketplaceEnv,
      workspace,
      process.env.CODEX_BIN || 'codex',
    );
    try {
      await marketplaceRpc.initialize();
      const listed = await marketplaceRpc.call('skills/list', {
        cwds: [workspace],
        forceReload: true,
      });
      assert.ok(
        listed.data.flatMap((entry) => entry.skills).some((skill) => skill.name === 'ld:go'),
      );
    } finally {
      marketplaceRpc.close();
    }
  }
  console.log(
    'PASS: isolated native installer, exact six-hook trust, unrelated config/auth preservation, idempotent reinstall, read-only doctor, disabled-feature detection, changed-script rejection and extra-hook rejection.',
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

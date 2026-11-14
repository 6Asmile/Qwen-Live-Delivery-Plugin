import { authorizeConfig, fetch } from './http-client.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  beginCd,
  currentState,
  publishVersion,
  markDone,
  runDeadlineTick,
} from '../.test-build/core.js';
import {
  changeSettings,
  queueFeedback,
  requestWrapUp,
  takeFeedbackContext,
  confirmTurnEnd,
} from '../.test-build/controls.js';
import { buildReadModel } from '../.test-build/read-model.js';
import { shouldOpenBrowser, openDeliveryOnce } from '../.test-build/browser.js';
import { createDeliveryServer } from '../.test-build/http.js';

function setup(t, extra = {}) {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'cd4-workbench-'));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  mkdirSync(path.join(workspaceDir, 'site/assets'), { recursive: true });
  writeFileSync(
    path.join(workspaceDir, 'site/landing.html'),
    '<script type="module" src="assets/app.js"></script><h1>First</h1>',
  );
  writeFileSync(
    path.join(workspaceDir, 'site/assets/app.js'),
    'document.body.dataset.ready="yes";',
  );
  return {
    workspaceDir,
    harness: 'codex',
    instance: `wb-${Date.now()}-${Math.random()}`,
    sessionKey: 'codex:workbench',
    port: 0,
    basePath: '/live-delivery',
    deliverEverySec: 60,
    timeBudgetSec: 600,
    minWorkingSec: 0,
    minReleases: 1,
    model: 'fixture',
    channels: false,
    openBrowser: 'never',
    ...extra,
  };
}
const plan = [
  {
    id: 'first',
    title: 'First version',
    scope: 'A complete page',
    acceptance: ['Loads offline'],
    target_after: '1m',
  },
  {
    id: 'second',
    title: 'More detail',
    scope: 'Interaction and explanation',
    acceptance: ['Controls respond'],
    target_after: '3m',
  },
];
const publish = (cfg, extra = {}) =>
  publishVersion(cfg, {
    paths: ['site'],
    preview_entry: path.join(cfg.workspaceDir, 'site/landing.html'),
    ...extra,
  });

test('structured plan attaches after hook start once, preserves original target, and gates unfinished milestones', (t) => {
  const cfg = setup(t);
  const original = beginCd(cfg, 'Raw user task').state;
  const planned = beginCd(cfg, 'Raw user task', { title: 'Concise title', milestones: plan }).state;
  assert.equal(planned.id, original.id);
  assert.equal(planned.name, 'Concise title');
  assert.equal(planned.milestones[0].targetTs, original.startedTs + 60000);
  assert.equal(beginCd(cfg, 'Raw user task', { milestones: [] }).state.milestones.length, 2);
  assert.equal(
    publish(cfg, {
      milestone_id: 'first',
      plan_update: [{ id: 'second', estimated_after: '4m', reason: 'Additional validation' }],
    }).ok,
    true,
  );
  const state = currentState(cfg),
    second = state.milestones[1];
  assert.equal(second.targetTs, original.startedTs + 180000);
  assert.equal(second.estimatedTs, original.startedTs + 240000);
  assert.equal(state.planRevisions.length, 1);
  assert.equal(markDone(cfg, 'Too soon').ok, false);
  assert.equal(publish(cfg, { milestone_id: 'unknown' }).ok, false);
});

test('explicit preview accepts workspace absolute files and index directories; never guesses an unrelated absolute path', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Site');
  const r = publish(cfg);
  assert.equal(r.ok, true);
  assert.equal(r.state.published.previewEntry, 'site/landing.html');
  assert.equal(r.state.published.files.length, 2);
  assert.equal(r.state.published.files[0].sha256.length, 64);
  assert.equal(publish(cfg, { preview_entry: '/outside/site/landing.html' }).ok, false);
  writeFileSync(path.join(cfg.workspaceDir, 'site/index.html'), '<h1>Index</h1>');
  const next = publish(cfg, { preview_entry: path.join(cfg.workspaceDir, 'site') });
  assert.equal(next.ok, true);
  assert.equal(next.state.published.previewEntry, 'site/index.html');
  assert.equal(
    readFileSync(
      path.join(cfg.workspaceDir, '.live-delivery', r.state.id, 'versions/v1/site/landing.html'),
      'utf8',
    ).includes('First'),
    true,
  );
});

test('preview must be included in complete file list; partial missing never consumes a version', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Site');
  writeFileSync(path.join(cfg.workspaceDir, 'outside.html'), 'Outside this release');
  assert.equal(publish(cfg, { preview_entry: 'outside.html' }).ok, false);
  assert.equal(publish(cfg, { paths: ['site', 'missing.pdf'] }).ok, false);
  assert.equal(currentState(cfg).publishes.length, 0);
  assert.equal(publish(cfg).state.published.version, 1);
});

test('content hashes reject timestamp-only duplicates and overlapping inputs are deduplicated', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Site');
  assert.equal(
    publish(cfg, { paths: ['site', 'site/assets/app.js'] }).state.published.files.length,
    2,
  );
  utimesSync(
    path.join(cfg.workspaceDir, 'site/landing.html'),
    new Date(),
    new Date(Date.now() + 3000),
  );
  assert.match(publish(cfg).error, /no_changes/);
  assert.equal(currentState(cfg).publishes.length, 1);
  writeFileSync(
    path.join(cfg.workspaceDir, 'site/assets/app.js'),
    'document.body.dataset.ready="new";',
  );
  assert.equal(publish(cfg).state.published.version, 2);
});

test('private paths are excluded with a receipt; explicit private paths and symlink escapes fail', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Site');
  for (const name of ['.env', 'auth.json', '.env.local'])
    writeFileSync(path.join(cfg.workspaceDir, 'site', name), 'SENSITIVE_TEST_MARKER');
  mkdirSync(path.join(cfg.workspaceDir, 'site/.live-delivery'));
  writeFileSync(
    path.join(cfg.workspaceDir, 'site/.live-delivery/release.json'),
    'PRIVATE_RUNTIME_MARKER',
  );
  const r = publish(cfg);
  assert.equal(r.ok, true);
  assert.equal(r.state.published.files.length, 2);
  assert.equal(r.state.published.excluded.length, 4);
  assert.ok(r.state.published.excluded.includes('site/.live-delivery'));
  assert.equal(publish(cfg, { paths: ['site/.env'], preview_entry: undefined }).ok, false);
  const runtime = publish(cfg, {
    paths: [`.live-delivery/${r.state.id}/release.json`],
    preview_entry: undefined,
  });
  assert.equal(runtime.ok, false);
  assert.match(runtime.error, /Private\/runtime path cannot be published/);
  symlinkSync('/etc/passwd', path.join(cfg.workspaceDir, 'site/escape.txt'));
  assert.equal(publish(cfg).ok, false);
  assert.equal(currentState(cfg).publishes.length, 1);
});

test('copy failure cannot report success, increment the version or leave a partial snapshot', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Site');
  const original = publish(cfg).state;
  writeFileSync(path.join(cfg.workspaceDir, 'site/assets/app.js'), 'A real content change');
  const realCopy = fs.copyFileSync;
  try {
    fs.copyFileSync = (...args) => {
      if (String(args[0]).endsWith('landing.html')) throw new Error('Injected disk copy failure');
      return realCopy(...args);
    };
    syncBuiltinESMExports();
    const failed = publish(cfg);
    assert.equal(failed.ok, false);
    assert.match(failed.error, /disk copy failure/);
    assert.equal(currentState(cfg).publishes.length, 1);
    assert.deepEqual(
      readdirSync(path.join(cfg.workspaceDir, '.live-delivery', original.id, 'versions')),
      ['v1'],
    );
  } finally {
    fs.copyFileSync = realCopy;
    syncBuiltinESMExports();
  }
  assert.equal(publish(cfg).state.published.version, 2);
});

test('feedback persists, deduplicates retries, injects once, and records agent-reported version association', (t) => {
  const cfg = setup(t);
  const state = beginCd(cfg, 'Site').state;
  publish(cfg);
  const input = { id: 'feedback-test-123', text: 'Add keyboard controls', version: 1 };
  assert.equal(queueFeedback(cfg, state.id, input).status, 'queued');
  queueFeedback(cfg, state.id, input);
  assert.equal(currentState(cfg).feedback.length, 1);
  assert.equal(markDone(cfg, 'Too soon').ok, false);
  const context = takeFeedbackContext(cfg, 'PostToolUse');
  assert.match(context, /Add keyboard controls/);
  assert.equal(takeFeedbackContext(cfg, 'PostToolUse'), '');
  assert.equal(currentState(cfg).feedback[0].status, 'injected');
  writeFileSync(path.join(cfg.workspaceDir, 'site/assets/app.js'), 'document.onkeydown=()=>{};');
  assert.equal(publish(cfg, { feedback_ids: [input.id] }).ok, true);
  assert.equal(currentState(cfg).feedback[0].addressedVersion, 2);
  assert.throws(
    () => queueFeedback(cfg, state.id, { ...input, text: 'Different message' }),
    /different feedback/,
  );
});

test('only user controls can enlarge budget, settings revisions guard stale writes, and Stop confirms wrap-up', (t) => {
  const cfg = setup(t);
  const state = beginCd(cfg, 'Site').state;
  assert.equal(
    beginCd(cfg, 'Site', { timeBudgetSec: 900, title: 'Forbidden enlargement' }).ok,
    false,
  );
  const changed = changeSettings(cfg, state.id, {
    deliverEverySec: 120,
    timeBudgetSec: 900,
    revision: 1,
  });
  assert.equal(changed.settingsRevision, 2);
  assert.equal(changed.timeBudgetSec, 900);
  assert.throws(
    () => changeSettings(cfg, state.id, { deliverEverySec: 30, timeBudgetSec: 120, revision: 1 }),
    /another window/,
  );
  const requested = requestWrapUp(cfg, state.id);
  assert.equal(requested.status, 'working');
  assert.equal(requested.stopRequest.confirmedTs, undefined);
  confirmTurnEnd(cfg);
  assert.equal(currentState(cfg).status, 'paused');
  assert.ok(currentState(cfg).stopRequest.confirmedTs);
});

test('budget checks do not wait for delivery deadlines or fabricate cancellation', (t) => {
  const cfg = setup(t, { deliverEverySec: 300, timeBudgetSec: 30 });
  beginCd(cfg, 'Site', {}, 1000000);
  runDeadlineTick(cfg, 1030000);
  assert.equal(currentState(cfg).stopRequest.reason, 'budget');
  assert.equal(currentState(cfg).status, 'working');
  confirmTurnEnd(cfg, 1030500);
  assert.equal(currentState(cfg).status, 'paused');
});

test('auto-open is once per task, defaults to headless-safe, and always prints a usable URL', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Site');
  const logs = [];
  openDeliveryOnce(cfg, (s) => logs.push(s));
  openDeliveryOnce(cfg, (s) => logs.push(s));
  assert.equal(logs.filter((s) => s.startsWith('Delivery page:')).length, 1);
  assert.equal(shouldOpenBrowser('auto', 'linux', {}), false);
  assert.equal(
    shouldOpenBrowser('auto', 'linux', { DISPLAY: ':0', SSH_CONNECTION: 'remote' }),
    false,
  );
  assert.equal(shouldOpenBrowser('auto', 'linux', { DISPLAY: ':0' }), true);
  assert.equal(shouldOpenBrowser('never', 'darwin', {}), false);
});

test('HTTP read model uses explicit entry, protects mutations, isolates HTML, serves module assets and rejects orphan versions', async (t) => {
  const cfg = setup(t);
  const state = beginCd(cfg, 'Site', { milestones: plan }).state;
  publish(cfg, {
    milestone_id: 'first',
    checks: [{ label: 'Interaction', result: 'passed', evidence: 'Agent script' }],
  });
  const server = createDeliveryServer(cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cfg.port = server.address().port;
  authorizeConfig(cfg);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${cfg.port}/live-delivery`,
    observed = await (await fetch(base + '/api/state')).json();
  assert.equal(observed.apiVersion, 1);
  assert.equal(observed.releases[0].previewEntry, 'site/landing.html');
  assert.equal(observed.releases[0].checks[1].source, 'agent');
  const raw = await fetch(`http://127.0.0.1:${cfg.port}${observed.releases[0].previewUrl}`);
  assert.match(raw.headers.get('content-security-policy'), /^sandbox /);
  const module = await fetch(`${base}/raw/${state.id}/1/site/assets/app.js`, {
    headers: { Origin: 'null' },
  });
  assert.equal(module.headers.get('access-control-allow-origin'), '*');
  assert.equal(module.status, 200);
  const body = JSON.stringify({
    session_id: state.id,
    id: 'feedback-http-test',
    text: 'Test live queue',
  });
  const headers = {
    'Content-Type': 'application/json',
    'X-CD-Token': observed.csrfToken,
    Origin: new URL(base).origin,
  };
  assert.equal(
    (
      await fetch(base + '/api/feedback', {
        method: 'POST',
        body,
        headers: { ...headers, Origin: 'null' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + '/api/feedback', {
        method: 'POST',
        body,
        headers: { ...headers, 'X-CD-Token': 'wrong' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(base + '/api/feedback', { method: 'POST', body, headers })).status,
    200,
  );
  mkdirSync(path.join(cfg.workspaceDir, '.live-delivery', state.id, 'versions/v99'), {
    recursive: true,
  });
  writeFileSync(
    path.join(cfg.workspaceDir, '.live-delivery', state.id, 'versions/v99/leak.html'),
    'uncommitted',
  );
  assert.equal((await fetch(`${base}/raw/${state.id}/99/leak.html`)).status, 400);
  rmSync(path.join(cfg.workspaceDir, '.live-delivery', state.id, 'versions/v1/site/assets/app.js'));
  assert.equal(
    (await fetch(base + '/zip/' + state.id + '/1')).status,
    500,
    'Never download an incomplete archive as a successful version',
  );
  assert.equal(
    buildReadModel({ ...cfg, readOnly: true }, currentState(cfg), 'test').capabilities.feedback,
    false,
  );
});

test('plan deadlines follow pending node targets and retain overdue deadlines without interval rearming', (t) => {
  const cfg = setup(t);
  const s = beginCd(cfg, 'Task', { milestones: plan }, 1000000).state;
  assert.equal(s.nextDeadlineTs, 1060000);
  runDeadlineTick(cfg, 1070000);
  runDeadlineTick(cfg, 1100000);
  assert.equal(currentState(cfg).nextDeadlineTs, 1060000);
  assert.deepEqual(currentState(cfg).missedDeadlines, [1060000]);
  publishVersion(cfg, { paths: ['site'], milestone_id: 'first' }, 1100000);
  assert.equal(currentState(cfg).nextDeadlineTs, 1180000);
  assert.equal(
    beginCd(
      cfg,
      s.task,
      {
        planRevision: 1,
        estimates: [{ id: 'second', estimated_after: '300s', reason: 'Additional work needed' }],
      },
      1110000,
    ).ok,
    true,
  );
  runDeadlineTick(cfg, 1200000);
  assert.equal(currentState(cfg).nextDeadlineTs, 1300000);
  assert.deepEqual(currentState(cfg).missedDeadlines, [1060000]);
});

test('removed plan API rejects edits and read-only state exposes no plan editor', async (t) => {
  const cfg = setup(t);
  const s = beginCd(cfg, 'Task', { milestones: plan }).state;
  const server = createDeliveryServer(cfg);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  cfg.port = server.address().port;
  authorizeConfig(cfg);
  const base = `http://127.0.0.1:${server.address().port}/live-delivery`;
  const view = await (await fetch(base + '/api/state')).json();
  const headers = {
    'Content-Type': 'application/json',
    Origin: new URL(base).origin,
    'X-CD-Token': view.csrfToken,
  };
  const body = JSON.stringify({ session_id: s.id, revision: 1, settingsRevision: 1 });
  assert.equal(
    (
      await fetch(base + '/api/plan', {
        method: 'POST',
        headers: { ...headers, Origin: 'null' },
        body,
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + '/api/plan', { method: 'POST', headers, body })).status, 404);
  assert.equal((await (await fetch(base + '/api/state')).json()).capabilities.plan, false);
  cfg.readOnly = true;
  assert.equal((await fetch(base + '/api/plan', { method: 'POST', headers, body })).status, 409);
  assert.equal((await (await fetch(base + '/api/state')).json()).capabilities.plan, false);
});

test('Agent initial and revised plans cannot schedule deliveries beyond the authorized budget', (t) => {
  const cfg = setup(t, { timeBudgetSec: 180 });
  assert.equal(
    beginCd(cfg, 'Task', { milestones: [{ ...plan[0], target_after: '4m' }] }).ok,
    false,
  );
  assert.equal(currentState(cfg), null);
  beginCd(cfg, 'Task', { milestones: plan });
  const bad = publish(cfg, {
    milestone_id: 'first',
    plan_update: [{ id: 'second', estimated_after: '4m', reason: 'Needs more work' }],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /budget of 180s/);
  assert.equal(currentState(cfg).publishes.length, 0);
  assert.equal(currentState(cfg).milestones[1].estimatedTs, undefined);
});

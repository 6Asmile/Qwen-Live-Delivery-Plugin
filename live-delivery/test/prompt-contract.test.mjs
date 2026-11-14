import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginCd, currentState, publishVersion } from '../.test-build/core.js';
import { queueFeedback, takeFeedbackContext, requestWrapUp } from '../.test-build/controls.js';
import { nextStep } from '../.test-build/instructions.js';
import { callTool, TOOL_SCHEMAS } from '../.test-build/tools.js';
import { serializePriorContext } from '../.test-build/prior-context.js';
import { deliveryLinks, openDeliveryOnce } from '../.test-build/browser.js';

const milestone = {
  id: 'first',
  title: 'First result',
  scope: 'Offline experiment',
  acceptance: ['Works offline'],
  target_after: '1m',
};
function setup(t) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-prompt-contract-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const cfg = {
    workspaceDir,
    harness: 'codex',
    instance: 'contract',
    sessionKey: 'contract',
    port: 0,
    basePath: '/live-delivery',
    timeBudgetSec: 600,
    deliverEverySec: 120,
    minWorkingSec: 0,
    minReleases: 1,
    planMode: 'rolling',
  };
  assert.equal(beginCd(cfg, 'Full objective', { milestones: [milestone] }).ok, true);
  return cfg;
}

test('a forecast changes independently of artifacts, preserves acceptance and budget, and rejects stale edits', (t) => {
  const cfg = setup(t),
    first = currentState(cfg);
  const r = callTool(cfg, 'ld_begin', {
    task: first.task,
    plan_revision: 1,
    estimates: [
      { id: 'first', estimated_after: '2m', reason: 'More time needed for offline validation' },
    ],
  });
  assert.equal(r.structuredContent.ok, true, r.content[0].text);
  const updated = currentState(cfg);
  assert.equal(updated.publishes.length, 0);
  assert.equal(updated.milestones[0].targetTs, first.milestones[0].targetTs);
  assert.equal(updated.milestones[0].estimatedTs, first.startedTs + 120000);
  assert.equal(updated.milestones[0].scope, first.milestones[0].scope);
  assert.deepEqual(updated.milestones[0].acceptance, first.milestones[0].acceptance);
  assert.equal(updated.timeBudgetSec, first.timeBudgetSec);
  assert.equal(updated.planRevision, 2);
  assert.equal(r.structuredContent.next_action.kind, 'deliver_pending');
  queueFeedback(cfg, updated.id, { id: 'offline-choice', text: 'Keep an offline comparison' });
  takeFeedbackContext(cfg, 'PostToolUse');
  assert.equal(
    beginCd(cfg, first.task, {
      planRevision: 2,
      reviseMilestone: {
        ...milestone,
        scope: 'Keep an offline comparison',
        target_after: '3m',
        reason: 'Requested comparison',
        feedback_ids: ['offline-choice'],
      },
    }).ok,
    true,
  );
  const userEdited = currentState(cfg);
  assert.equal(
    beginCd(cfg, first.task, {
      planRevision: 2,
      estimates: [{ id: 'first', estimated_after: '4m', reason: 'Stale model turn' }],
    }).ok,
    false,
  );
  assert.deepEqual(currentState(cfg), userEdited);
  for (const estimates of [
    [{ id: 'first', estimated_after: '11m', reason: 'Over budget' }],
    [{ id: 'first', estimated_after: '1s', reason: 'In the past' }],
    [{ id: 'first', estimated_after: '4m', reason: 'x', scope: 'Weaken scope' }],
    [
      { id: 'first', estimated_after: '4m', reason: 'x' },
      { id: 'first', estimated_after: '5m', reason: 'y' },
    ],
  ]) {
    assert.equal(
      beginCd(
        cfg,
        first.task,
        { planRevision: userEdited.planRevision, estimates },
        userEdited.startedTs + 2000,
      ).ok,
      false,
    );
    assert.deepEqual(currentState(cfg), userEdited);
  }
  assert.equal(
    TOOL_SCHEMAS.ld_begin.safeParse({
      task: first.task,
      plan_revision: 3,
      estimates: [{ id: 'first', estimated_after: '4m', reason: 'x', acceptance: ['Weaker'] }],
    }).success,
    false,
  );
});

test('estimate updates cannot change delivered history or bypass wrap-up', (t) => {
  const cfg = setup(t),
    first = currentState(cfg);
  const opts = {
    planRevision: 1,
    estimates: [{ id: 'first', estimated_after: '2m', reason: 'Recheck' }],
  };
  fs.writeFileSync(path.join(cfg.workspaceDir, 'index.html'), '<h1>Offline result</h1>');
  assert.equal(
    publishVersion(cfg, {
      paths: ['index.html'],
      preview_entry: 'index.html',
      milestone_id: 'first',
      checks: [{ label: 'Works offline', result: 'passed' }],
    }).ok,
    true,
  );
  const published = currentState(cfg);
  assert.equal(beginCd(cfg, first.task, opts).ok, false);
  assert.deepEqual(currentState(cfg), published);
  requestWrapUp(cfg, first.id);
  assert.equal(beginCd(cfg, first.task, opts).ok, false);
});

test('publication guides the next rolling milestone, and stop takes priority over both', (t) => {
  const cfg = setup(t),
    first = currentState(cfg);
  fs.writeFileSync(path.join(cfg.workspaceDir, 'index.html'), '<h1>Offline result</h1>');
  const r = callTool(cfg, 'ld_publish', {
    paths: ['index.html'],
    preview_entry: 'index.html',
    milestone_id: 'first',
    plan_revision: currentState(cfg).planRevision,
    checks: [{ label: 'Works offline', result: 'passed' }],
  });
  assert.equal(r.structuredContent.ok, true, r.content[0].text);
  assert.equal(r.structuredContent.next_action.kind, 'plan_next');
  const next = callTool(cfg, 'ld_begin', {
    task: first.task,
    plan_revision: currentState(cfg).planRevision,
    next_milestone: { ...milestone, id: 'next', target_after: '3m' },
  });
  assert.equal(next.structuredContent.next_action.kind, 'deliver_pending');
  assert.equal(next.structuredContent.next_action.milestone_id, 'next');
  const state = currentState(cfg);
  assert.equal(nextStep({ ...state, milestones: [state.milestones[0]] }).kind, 'plan_next');
  assert.equal(
    nextStep({ ...state, milestones: [state.milestones[0]], planMode: 'fixed' }).kind,
    'finish_fixed_plan',
  );
  assert.equal(nextStep(state, state.startedTs + state.timeBudgetSec * 1000).kind, 'wrap_up');
  requestWrapUp(cfg, state.id);
  assert.equal(callTool(cfg, 'ld_status', {}).structuredContent.next_action.kind, 'wrap_up');
  assert.equal(nextStep({ ...state, status: 'done' }).kind, 'finished');
});

test('long continuation context stays valid, bounded, marked and preserves latest user changes and version', () => {
  const rounds = [
    { title: 'Original', request: 'original objective', lastVersion: 1, messages: [] },
    {
      title: 'Latest',
      request: 'Add comparison',
      lastVersion: 25,
      summary: '\\"'.repeat(40000),
      previewEntry: 'index.html',
      paths: ['index.html'],
      messages: [
        { role: 'agent', text: 'x'.repeat(100000) },
        { role: 'user', text: 'Keep keyboard access and offline use.' },
      ],
    },
  ];
  for (const limit of [60000, 2000]) {
    const encoded = serializePriorContext(rounds, limit),
      context = JSON.parse(encoded);
    assert.ok(encoded.length <= limit);
    assert.equal(context.earliest_retained_request, 'original objective');
    assert.equal(context.latest_request, 'Add comparison');
    assert.equal(context.latest_user_message, 'Keep keyboard access and offline use.');
    assert.equal(context.latest_delivery.version, 25);
    assert.equal(context.truncated, true);
  }
  assert.deepEqual(JSON.parse(serializePriorContext([])), {});
  const simple = { title: 'Title', request: 'Request', lastVersion: 1, messages: [] };
  assert.equal(JSON.parse(serializePriorContext([simple])).truncated, false);
  for (const extra of [
    { title: 'x'.repeat(1001) },
    { previewEntry: 'x'.repeat(2001) },
    { paths: ['x'.repeat(1001)] },
  ]) {
    assert.equal(JSON.parse(serializePriorContext([{ ...simple, ...extra }])).truncated, true);
  }
});

test('embedded links use the refreshed parent entry and never silently fall back to a child port', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-dashboard-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dashboardFile = path.join(dir, 'entry.json'),
    cfg = { port: 1111, basePath: '/live-delivery', dashboardFile };
  const old = 'http://localhost:2222/live-delivery/?s=session&run=run#access=fixture-one';
  fs.writeFileSync(dashboardFile, JSON.stringify({ sessionId: 'session', urls: [old] }));
  assert.deepEqual(deliveryLinks(cfg, 'session'), [old]);
  const current = old.replace('2222', '3333').replace('fixture-one', 'fixture-two');
  fs.writeFileSync(dashboardFile, JSON.stringify({ sessionId: 'session', urls: [current] }));
  assert.deepEqual(deliveryLinks(cfg, 'session'), [current]);
  assert.deepEqual(deliveryLinks(cfg), [current]);
  assert.deepEqual(deliveryLinks(cfg, 'wrong-session'), []);
  fs.writeFileSync(dashboardFile, '{broken');
  assert.deepEqual(deliveryLinks(cfg, 'session'), []);
});

test('SSH guidance uses the public parent port rather than the private child listener', (t) => {
  const cfg = setup(t);
  cfg.dashboardFile = path.join(cfg.workspaceDir, 'entry.json');
  cfg.port = 1111;
  cfg.openBrowser = 'never';
  const state = currentState(cfg);
  fs.writeFileSync(
    cfg.dashboardFile,
    JSON.stringify({
      sessionId: state.id,
      urls: [`http://127.0.0.1:2222/live-delivery/?s=${state.id}&run=parent`],
    }),
  );
  const logs = [];
  openDeliveryOnce(cfg, (line) => logs.push(line));
  assert.ok(logs.some((line) => line.includes('forward port 2222')));
  assert.ok(logs.every((line) => !line.includes('1111')));
});

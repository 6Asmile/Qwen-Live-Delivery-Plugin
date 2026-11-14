import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginCd, currentState, publishVersion } from '../.test-build/core.js';
import { queueFeedback, takeFeedbackContext } from '../.test-build/controls.js';
import { callTool } from '../.test-build/tools.js';

test('chat-revised plans and scope-only changes invalidate an in-flight publication without consuming a version', (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-plan-publication-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const cfg = {
    workspaceDir,
    instance: 'plan-update',
    harness: 'codex',
    sessionKey: 'plan-update',
    port: 0,
    basePath: '/live-delivery',
    planMode: 'rolling',
    timeBudgetSec: 600,
    deliverEverySec: 60,
    minWorkingSec: 0,
    minReleases: 1,
  };
  const first = beginCd(cfg, 'Build an offline reference', {
    milestones: [
      {
        id: 'first',
        title: 'Working page',
        scope: 'Offline reference',
        acceptance: ['Opens offline'],
        target_after: '1m',
      },
    ],
  }).state;
  const file = path.join(workspaceDir, 'index.html');
  const input = {
    paths: ['index.html'],
    preview_entry: 'index.html',
    milestone_id: 'first',
    plan_revision: 1,
    checks: [{ label: 'Opens offline', result: 'passed' }],
  };
  fs.writeFileSync(file, '<h1>Usable reference</h1>');
  assert.equal(publishVersion(cfg, input).ok, true);
  const snapshot = currentState(cfg).published;
  const second = beginCd(cfg, first.task, {
    planRevision: 1,
    nextMilestone: {
      id: 'user-next',
      title: 'Visual reference',
      scope: 'Explain the structure with diagrams',
      acceptance: ['Opens offline'],
      target_after: '3m',
    },
  }).state;
  assert.equal(
    beginCd(cfg, first.task, {
      planRevision: second.planRevision,
      nextMilestone: {
        id: 'unrequested',
        title: 'More',
        scope: 'Other work',
        acceptance: ['Opens offline'],
        target_after: '4m',
      },
    }).ok,
    false,
  );
  const inFlight = { ...input, milestone_id: 'user-next', plan_revision: second.planRevision };
  queueFeedback(cfg, first.id, {
    id: 'style-change',
    text: 'Use monochrome technical diagrams throughout the reference',
  });
  const context = takeFeedbackContext(cfg, 'PostToolUse');
  assert.ok(context.includes('monochrome technical diagrams'));
  const changed = beginCd(cfg, 'Build an offline reference with monochrome technical diagrams', {
    planRevision: second.planRevision,
    reviseMilestone: {
      id: 'user-next',
      title: 'Visual reference',
      scope: 'Use monochrome technical diagrams throughout the reference',
      acceptance: ['Opens offline'],
      target_after: '3m',
      reason: 'Apply the requested diagram style',
      feedback_ids: ['style-change'],
    },
  }).state;
  assert.equal(changed.task, 'Build an offline reference with monochrome technical diagrams');
  assert.equal(changed.messages[0].text, first.task);
  fs.writeFileSync(file, '<h1>Old candidate</h1>');
  for (const candidate of [inFlight, { ...inFlight, plan_revision: undefined }]) {
    const rejected = publishVersion(cfg, candidate);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /plan_revision/);
    assert.deepEqual(currentState(cfg).published, snapshot);
    assert.equal(currentState(cfg).publishes.length, 1);
  }
  const observed = callTool(cfg, 'ld_status', {}).structuredContent.state;
  assert.equal(observed.planRevision, changed.planRevision);
  fs.writeFileSync(file, '<h1>Reference with monochrome technical diagrams</h1>');
  const published = publishVersion(cfg, { ...inFlight, plan_revision: observed.planRevision });
  assert.equal(published.ok, true, published.error);
  assert.equal(published.state.published.version, 2);
  fs.writeFileSync(file, '<h1>Another change</h1>');
  assert.match(
    publishVersion(cfg, { ...inFlight, plan_revision: observed.planRevision }).error,
    /already delivered/,
  );
  assert.equal(currentState(cfg).publishes.length, 2);
});

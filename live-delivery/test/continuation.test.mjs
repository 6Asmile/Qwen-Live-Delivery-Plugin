import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginCd,
  startTask,
  currentState,
  continuationFrom,
  publishVersion,
  markDone,
} from '../.test-build/core.js';
import { buildReadModel } from '../.test-build/read-model.js';
import { writeState } from '../.test-build/state.js';
import { takeFeedbackContext, requestWrapUp, queueFeedback } from '../.test-build/controls.js';

const milestones = ['first', 'second'].map((id, i) => ({
  id,
  title: id,
  scope: 'Usable improvement',
  acceptance: ['Opens'],
  target_after: `${i + 1}m`,
}));
function setup(t) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-continuation-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  return {
    workspaceDir,
    harness: 'codex',
    sessionKey: 'codex:test',
    instance: 'test',
    port: 18799,
    basePath: '/live-delivery',
    timeBudgetSec: 600,
    deliverEverySec: 60,
    minWorkingSec: 0,
    minReleases: 1,
  };
}
function publish(cfg, text, milestone_id) {
  fs.writeFileSync(path.join(cfg.workspaceDir, 'index.html'), `<h1>${text}</h1>`);
  const result = publishVersion(cfg, {
    paths: ['index.html'],
    preview_entry: 'index.html',
    milestone_id,
  });
  assert.equal(result.ok, true, result.error);
  return result.state;
}

test('continuations number actual snapshots, plans after the last publication', async (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Initial request', { milestones });
  publish(cfg, 'First', 'first');
  publish(cfg, 'Second', 'second');
  assert.equal(markDone(cfg, 'Done').ok, true);
  const previous = currentState(cfg),
    file = path.join(cfg.workspaceDir, '.live-delivery', previous.id, 'release.json');
  const original = fs.readFileSync(file, 'utf8');
  const frozen = path.join(
    cfg.workspaceDir,
    '.live-delivery',
    previous.id,
    'versions/v2/index.html',
  );
  const originalSnapshot = fs.readFileSync(frozen, 'utf8');
  const next = beginCd(cfg, 'Add a comparison', { milestones }).state;
  assert.notEqual(next.id, previous.id);
  assert.equal(next.continuation.version, 2);
  const view = buildReadModel(cfg, next, 'test');
  assert.deepEqual(
    view.plan.map((m) => m.version),
    [3, 4],
  );
  assert.equal(view.task.nextVersion, 3);
  queueFeedback(cfg, next.id, {
    id: 'reference-old-version',
    text: 'Keep the V1 behavior',
    version: 1,
  });
  assert.match(takeFeedbackContext(cfg, 'PostToolUse'), /Keep the V1 behavior/);
  assert.throws(
    () => queueFeedback(cfg, next.id, { id: 'nonexistent-version', text: 'No', version: 9 }),
    /not a published version/,
  );
  const duplicate = publishVersion(cfg, {
    paths: ['index.html'],
    preview_entry: 'index.html',
    milestone_id: 'first',
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /no_changes/);
  assert.equal(publishVersion(cfg, { paths: ['missing.html'] }).ok, false);
  assert.equal(buildReadModel(cfg, currentState(cfg), 'test').task.nextVersion, 3);
  assert.equal(publish(cfg, 'Comparison', 'first').published.version, 3);
  assert.equal(
    fs.readFileSync(
      path.join(cfg.workspaceDir, '.live-delivery', next.id, 'versions/v3/index.html'),
      'utf8',
    ),
    '<h1>Comparison</h1>',
  );
  assert.equal(publish(cfg, 'Improved comparison', 'second').published.version, 4);
  assert.equal(markDone(cfg, 'Done').ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.readFileSync(frozen, 'utf8'), originalSnapshot);
  const delivered = buildReadModel(cfg, currentState(cfg), 'test');
  assert.deepEqual(
    delivered.plan.map((m) => m.version),
    [3, 4],
  );
  assert.ok(delivered.releases[0].previewUrl.includes('/3/index.html'));
  assert.ok(delivered.releases[1].downloadUrl.endsWith('/4'));
  const fresh = startTask(cfg, 'Separate task').state;
  assert.equal(buildReadModel(cfg, fresh, 'test').task.nextVersion, 1);
  assert.throws(
    () => queueFeedback(cfg, fresh.id, { id: 'unrelated-version', text: 'No', version: 2 }),
    /not a published version/,
  );
});

test('empty stopped rounds preserve the published floor, but never inherit unpublished candidates or work credit', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Original');
  const first = publish(cfg, 'Usable');
  markDone(cfg, 'Done');
  const withCandidate = { ...currentState(cfg), staged: { ...first.published, version: 12 } };
  assert.equal(continuationFrom(withCandidate).version, 1);
  const next = startTask(cfg, 'Continue', Date.now(), continuationFrom(withCandidate)).state;
  assert.equal(markDone(cfg, 'No new work').ok, false);
  requestWrapUp(cfg, next.id);
  assert.equal(markDone(cfg, 'Stopped before making a new version').ok, true);
  const empty = currentState(cfg);
  assert.equal(continuationFrom(empty).version, 1);
  assert.equal(continuationFrom(empty).digest, first.published.digest);
  const last = startTask(cfg, 'Continue again', Date.now(), continuationFrom(empty)).state;
  // Reload the persisted state, without relying on an in-memory counter.
  writeState(cfg.workspaceDir, last);
  assert.equal(buildReadModel(cfg, currentState({ ...cfg }), 'test').task.nextVersion, 2);
  assert.equal(publish(cfg, 'More useful').published.version, 2);
});

test('pending plan numbers do not collide when a milestone has more than one publication', (t) => {
  const cfg = setup(t);
  beginCd(cfg, 'Multiple updates', { milestones });
  publish(cfg, 'First', 'first');
  publish(cfg, 'First corrected', 'first');
  assert.deepEqual(
    buildReadModel(cfg, currentState(cfg), 'test').plan.map((m) => m.version),
    [2, 3],
  );
});

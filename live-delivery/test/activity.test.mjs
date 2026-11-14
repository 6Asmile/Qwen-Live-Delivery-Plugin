import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginCd, currentState, publishVersion, markDone } from '../.test-build/core.js';
import { callTool } from '../.test-build/tools.js';
import { reportActivity, requestWrapUp } from '../.test-build/controls.js';
import { buildReadModel } from '../.test-build/read-model.js';

function setup(t) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-activity-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const cfg = {
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
  beginCd(cfg, 'Build a site', {
    milestones: [
      {
        id: 'first',
        title: 'First',
        scope: 'Working page',
        acceptance: ['Opens'],
        target_after: '1m',
      },
    ],
  });
  return cfg;
}
test('work updates replace a persisted status without changing the plan, budget, chat or publication counters', (t) => {
  const cfg = setup(t),
    before = currentState(cfg);
  const response = callTool(cfg, 'ld_status', { activity: '正在搭建基础框架' });
  assert.equal(response.structuredContent.ok, true);
  assert.equal(response.structuredContent.state.activity.text, '正在搭建基础框架');
  reportActivity(cfg, '正在绘制结构图', 1234);
  const after = currentState(cfg);
  assert.deepEqual(after.activity, { text: '正在绘制结构图', ts: 1234 });
  assert.deepEqual({ ...after, activity: undefined }, { ...before, activity: undefined });
  assert.deepEqual(buildReadModel(cfg, after, 'test').task.activity, after.activity);
  const read = callTool(cfg, 'ld_status', {});
  assert.equal(read.structuredContent.state.activity.ts, 1234);
  assert.equal(callTool(cfg, 'ld_status', { activity: 'x'.repeat(161) }).isError, true);
  assert.equal(callTool(cfg, 'ld_status', { activity: ' ' }).isError, true);
  assert.equal(callTool(cfg, 'ld_status', { activity: 'text\u001b' }).isError, true);
  fs.writeFileSync(path.join(cfg.workspaceDir, 'index.html'), '<h1>Ready</h1>');
  assert.equal(publishVersion(cfg, { paths: ['index.html'], milestone_id: 'first' }).ok, true);
  assert.equal(buildReadModel(cfg, currentState(cfg), 'test').task.activity, null);
  reportActivity(cfg, '正在检查链接');
  assert.equal(markDone(cfg, 'Done').ok, true);
  assert.equal(buildReadModel(cfg, currentState(cfg), 'test').task.activity, null);
  assert.equal(callTool(cfg, 'ld_status', { activity: 'Still working' }).isError, true);
});
test('stopping takes precedence over an agent work update', (t) => {
  const cfg = setup(t),
    pending = currentState(cfg);
  reportActivity(cfg, '正在实现交互');
  requestWrapUp(cfg, pending.id);
  assert.equal(buildReadModel(cfg, currentState(cfg), 'test').task.activity, null);
  assert.equal(callTool(cfg, 'ld_status', { activity: 'Another phase' }).isError, true);
  assert.equal(callTool(cfg, 'ld_status', {}).structuredContent.ok, true);
});

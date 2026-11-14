#!/usr/bin/env node
// Deterministic native-process substitute for workbench lifecycle tests.
import fs from 'node:fs';
import path from 'node:path';
import { beginCd, publishVersion, markDone, currentState } from '../.test-build/core.js';
import {
  takeFeedbackContext,
  reportActivity,
  requestWrapUp,
  confirmTurnEnd,
} from '../.test-build/controls.js';
import { nextArtifactVersion } from '../.test-build/engine.js';
if (process.argv[2] === 'plugin') process.exit(0);
if (process.argv[2] === 'app-server') {
  const { createInterface } = await import('node:readline');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const states = new Map();
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result = {};
    if (message.method === 'config/read') result = { config: { features: { hooks: true } } };
    if (message.method === 'config/value/write')
      states.set(message.params.keyPath, message.params.value);
    if (message.method === 'hooks/list')
      result = {
        data: [
          {
            hooks: Array.from({ length: 6 }, (_, i) => {
              const key = 'ld@live-delivery-local:fixture-' + i;
              const trusted = states.has('hooks.state.' + JSON.stringify(key));
              return {
                pluginId: 'ld@live-delivery-local',
                source: 'plugin',
                handlerType: 'command',
                sourcePath: path.join(root, 'hooks/hooks.json'),
                key,
                currentHash: 'fixture-hash',
                enabled: trusted,
                trustStatus: trusted ? 'trusted' : 'untrusted',
              };
            }),
          },
        ],
      };
    console.log(JSON.stringify({ id: message.id, result }));
  }
  process.exit(0);
}
if (process.argv.includes('--dangerously-bypass-hook-trust'))
  throw new Error('Hook trust bypass is forbidden');
let prompt = '';
for await (const part of process.stdin) prompt += part;
const resumed = prompt.startsWith('Live Delivery:');
if (!resumed && !prompt.startsWith('$ld:go ')) throw new Error('Wrong public skill invocation');
if (prompt.includes('[FAIL]')) process.exit(5);
const dir = process.env.QWEN_LD_WORKSPACE;
if (prompt.includes('[WAIT-INTERRUPT]'))
  process.on('SIGINT', () => {
    fs.writeFileSync(path.join(dir, '.interrupting-fixture'), 'waiting');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    process.exit(0);
  });
const cfg = {
  workspaceDir: dir,
  harness: 'codex',
  planMode: 'rolling',
  sessionKey: process.env.QWEN_LD_SESSION_KEY,
  instance: process.env.QWEN_LD_INSTANCE_ID,
  port: 0,
  basePath: '/live-delivery',
  timeBudgetSec: 300,
  deliverEverySec: 60,
  minWorkingSec: 0,
  minReleases: 1,
  model: 'fixture',
  channels: false,
  requirePlanApproval: false,
};
fs.writeFileSync(path.join(dir, 'received-prompt.txt'), prompt);
console.log(
  JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' }),
);
if (!resumed)
  beginCd(cfg, prompt.slice('$ld:go '.length), {
    title: path.basename(dir) + ' task',
    milestones: [
      { id: 'first', title: 'First', scope: 'Usable', acceptance: ['Opens'], target_after: '10s' },
      ...(cfg.planMode === 'rolling'
        ? []
        : [
            {
              id: 'final',
              title: 'Final',
              scope: 'Improved',
              acceptance: ['Explained'],
              target_after: '30s',
            },
          ]),
    ],
  });
if (!currentState(cfg)) process.exit(0);
if (!resumed) {
  const initialContext = takeFeedbackContext(cfg, 'PostToolUse');
  if (initialContext)
    fs.appendFileSync(path.join(dir, 'received-feedback.txt'), initialContext + '\n');
  fs.mkdirSync(path.join(dir, 'output/sub'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'output/sub/index.html'),
    '<h1 id="child">Details</h1><a id="back" href="../">Back</a>',
  );
  fs.writeFileSync(
    path.join(dir, 'output/index.html'),
    '<h1 id="case">' +
      path.basename(dir) +
      ' v' +
      nextArtifactVersion(currentState(cfg)) +
      '</h1><a id="details" href="sub/">Details</a>',
  );
  if (
    !publishVersion(cfg, {
      paths: ['output'],
      note: 'A usable reference page with working detail navigation.',
      preview_entry: 'output/index.html',
      plan_revision: currentState(cfg).planRevision,
      milestone_id: 'first',
      checks: [{ label: 'Opens', result: 'passed' }],
    }).ok
  )
    throw new Error('Publish failed');
} else {
  const context = takeFeedbackContext(
    cfg,
    'UserPromptSubmit',
    Date.now(),
    process.env.QWEN_LD_FEEDBACK_HANDOFF,
  );
  if (context) fs.appendFileSync(path.join(dir, 'received-feedback.txt'), context + '\n');
}
if (cfg.planMode === 'rolling') {
  for (let i = 0; i < 1200; i++) {
    const context = prompt.includes('[WAIT-INTERRUPT]')
      ? ''
      : takeFeedbackContext(cfg, 'PostToolUse');
    if (context) fs.appendFileSync(path.join(dir, 'received-feedback.txt'), context + '\n');
    const state = currentState(cfg);
    const feedback = state.feedback
      ?.filter((f) => f.status === 'injected' && f.text.startsWith('Next version:'))
      .at(-1);
    const pending = state.milestones?.find(
      (m) => !state.publishes.some((p) => p.artifact?.milestoneId === m.id),
    );
    if (
      feedback &&
      pending &&
      !state.planRevisions?.some((r) => r.feedbackIds?.includes(feedback.id))
    ) {
      const result = beginCd(cfg, state.task, {
        planRevision: state.planRevision,
        reviseMilestone: {
          id: pending.id,
          title: 'Revised next version',
          scope: feedback.text,
          acceptance: ['Opens'],
          target_after: Math.ceil((Date.now() - state.startedTs) / 1000 + 40) + 's',
          reason: 'Updated the next version from your message.',
          feedback_ids: [feedback.id],
        },
      });
      if (!result.ok) throw new Error(result.error);
    }
    const streamFile = path.join(dir, '.stream-fixture');
    if (fs.existsSync(streamFile)) {
      const records = JSON.parse(fs.readFileSync(streamFile, 'utf8'));
      fs.rmSync(streamFile);
      for (const record of records) console.log(JSON.stringify(record));
    }
    const eventsFile = path.join(dir, '.events-fixture');
    if (fs.existsSync(eventsFile)) {
      const count = Number(fs.readFileSync(eventsFile, 'utf8'));
      fs.rmSync(eventsFile);
      for (let n = 0; n < count; n++)
        console.log(
          JSON.stringify({
            type: 'item.completed',
            item: {
              id: 'event-' + Date.now() + '-' + n,
              type: 'command_execution',
              command: 'npm run build --secret PRIVATE_VALUE',
              exit_code: 0,
              aggregated_output: 'PRIVATE_OUTPUT',
            },
          }),
        );
    }
    if (state.stopRequest || fs.existsSync(path.join(dir, '.finish-fixture'))) {
      fs.rmSync(path.join(dir, '.finish-fixture'), { force: true });
      requestWrapUp(cfg, state.id);
      markDone(cfg, 'Stopped; latest usable snapshot retained');
      confirmTurnEnd(cfg);
      process.exit(0);
    }
    for (const action of ['plan-next', 'publish-next']) {
      const file = path.join(dir, '.' + action + '-fixture');
      if (!fs.existsSync(file)) continue;
      fs.rmSync(file);
      const version = nextArtifactVersion(currentState(cfg));
      let result;
      if (action === 'plan-next') {
        result = beginCd(cfg, state.task, {
          nextMilestone: {
            id: 'step-' + version,
            title: 'Capability ' + version,
            scope: 'A substantial new capability',
            acceptance: ['Opens'],
            target_after: Math.ceil((Date.now() - state.startedTs) / 1000 + 30) + 's',
          },
          planRevision: state.planRevision ?? 1,
        });
      } else {
        fs.writeFileSync(
          path.join(dir, 'output/index.html'),
          '<h1 id="case">' +
            path.basename(dir) +
            ' v' +
            version +
            '</h1><a id="details" href="sub/">Details</a>',
        );
        result = publishVersion(cfg, {
          paths: ['output'],
          note: 'Added the next capability and incorporated the requested changes.',
          preview_entry: 'output/index.html',
          plan_revision: currentState(cfg).planRevision,
          milestone_id: 'step-' + version,
          checks: [{ label: 'Opens', result: 'passed' }],
          feedback_ids: currentState(cfg)
            .feedback?.filter((f) => f.status === 'injected')
            .map((f) => f.id),
        });
      }
      if (!result.ok) throw new Error(result.error);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Rolling fixture timed out');
}
for (let i = 0; i < 1200; i++) {
  if (currentState(cfg)?.stopRequest) {
    markDone(cfg, 'Stopped; latest usable snapshot retained');
    confirmTurnEnd(cfg);
    process.exit(0);
  }
  const activityFile = path.join(dir, '.activity-fixture');
  if (fs.existsSync(activityFile)) {
    const update = JSON.parse(fs.readFileSync(activityFile, 'utf8'));
    fs.rmSync(activityFile);
    reportActivity(cfg, update.text, update.ts ?? Date.now());
  }
  const feedback = takeFeedbackContext(cfg, 'PostToolUse');
  if (feedback) fs.appendFileSync(path.join(dir, 'received-feedback.txt'), feedback + '\n');
  if (fs.existsSync(path.join(dir, '.finish-fixture'))) {
    // Consume the signal so a follow-up round does not finish immediately.
    fs.rmSync(path.join(dir, '.finish-fixture'), { force: true });
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
fs.writeFileSync(
  path.join(dir, 'output/index.html'),
  '<h1 id="case">' +
    path.basename(dir) +
    ' v' +
    nextArtifactVersion(currentState(cfg)) +
    '</h1><a id="details" href="sub/">Details</a>',
);
publishVersion(cfg, {
  paths: ['output'],
  preview_entry: 'output/index.html',
  plan_revision: currentState(cfg).planRevision,
  milestone_id: 'final',
});
markDone(cfg, 'Fixture complete');

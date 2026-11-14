import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beginCd, publishVersion, currentState } from '../.test-build/core.js';
import { createDeliveryServer } from '../.test-build/http.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  workspaceDir = mkdtempSync(path.join(tmpdir(), 'cd4-browser-'));
const cfg = {
  workspaceDir,
  harness: 'codex',
  sessionKey: 'codex:browser-test',
  instance: `browser-${process.pid}`,
  port: 0,
  basePath: '/live-delivery',
  deliverEverySec: 60,
  timeBudgetSec: 600,
  minWorkingSec: 0,
  minReleases: 1,
  model: 'scripted-test',
  channels: false,
};
mkdirSync(path.join(workspaceDir, 'site/assets'), { recursive: true });
writeFileSync(path.join(workspaceDir, 'site/assets/util.js'), 'export const ready="module-ready";');
writeFileSync(path.join(workspaceDir, 'site/assets/values.json'), '{"value":42}');
writeFileSync(
  path.join(workspaceDir, 'site/assets/app.js'),
  'import {ready} from "./util.js";const data=await(await fetch(new URL("./values.json",import.meta.url))).json();document.querySelector("#status").textContent=ready+":"+data.value;window.instanceId=Math.random();document.querySelector("#probe").onclick=async()=>{document.querySelector("#probe-result").textContent="checking";try{await fetch("/live-delivery/api/state",{signal:AbortSignal.timeout(5000)});document.querySelector("#probe-result").textContent="allowed"}catch(e){document.querySelector("#probe-result").textContent=e.name==="TypeError"?"blocked":e.name}};',
);
writeFileSync(
  path.join(workspaceDir, 'site/style.css'),
  'body{font:18px sans-serif;padding:30px;background:#eef2ff;color:#181839}input{display:block;width:80%;margin:30px 0}',
);
writeFileSync(
  path.join(workspaceDir, 'site/details.html'),
  '<h1 id="details">Supporting page</h1>',
);
const html = (n) =>
  `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><h1 id="version">Version ${n}</h1><p id="status">loading</p><input id="slider" type="range" value="20"><button id="probe">Origin probe</button><p id="probe-result"></p><script type="module" src="assets/app.js"></script>`;
writeFileSync(path.join(workspaceDir, 'site/guide.html'), html(1));
const state = beginCd(cfg, 'Browser integration fixture', {
  title: 'Multi-file delivery',
  milestones: [
    {
      id: 'first',
      title: 'First',
      scope: 'Usable page',
      acceptance: ['Module loads'],
      target_after: '1m',
    },
    {
      id: 'second',
      title: 'Second',
      scope: 'Improved page',
      acceptance: ['Feedback addressed'],
      target_after: '2m',
    },
  ],
}).state;
publishVersion(cfg, {
  paths: ['site'],
  preview_entry: path.join(workspaceDir, 'site/guide.html'),
  milestone_id: 'first',
  note: 'First real snapshot',
  checks: [{ label: 'Module and JSON', result: 'passed', evidence: 'Fixture claim' }],
});
const server = createDeliveryServer(cfg);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
cfg.port = server.address().port;
console.log(
  JSON.stringify({
    url: `http://127.0.0.1:${cfg.port}/live-delivery/?s=${state.id}`,
    entryUrl: `http://127.0.0.1:${cfg.port}/live-delivery/?s=${state.id}#access=${cfg.accessToken}`,
    id: state.id,
    workspaceDir,
  }),
);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  try {
    const cmd = JSON.parse(line);
    if (cmd.action === 'publish') {
      writeFileSync(path.join(workspaceDir, 'site/guide.html'), html(2));
      const feedback = currentState(cfg)
        .feedback.filter((f) => f.status === 'injected')
        .map((f) => f.id);
      console.log(
        JSON.stringify(
          publishVersion(cfg, {
            paths: ['site'],
            preview_entry: 'site/guide.html',
            milestone_id: 'second',
            note: 'Second snapshot',
            feedback_ids: feedback,
          }),
        ),
      );
    } else if (cmd.action === 'hook') {
      const r = spawnSync(process.execPath, [path.join(root, 'dist/hook.mjs')], {
        env: {
          PATH: process.env.PATH,
          QWEN_LD_WORKSPACE: workspaceDir,
          QWEN_LD_SESSION_KEY: cfg.sessionKey,
          QWEN_LD_INSTANCE_ID: cfg.instance,
        },
        input: JSON.stringify({
          hook_event_name: cmd.event,
          session_id: 'browser-test',
          cwd: workspaceDir,
          tool_name: 'Bash',
          tool_use_id: 'browser-fixture-call',
        }),
        encoding: 'utf8',
      });
      console.log(JSON.stringify({ exit: r.status, output: r.stdout, error: r.stderr }));
    } else if (cmd.action === 'quit') {
      console.log('{"ok":true}');
      break;
    }
  } catch (e) {
    console.log(JSON.stringify({ error: String(e) }));
  }
}
lines.close();
process.stdin.destroy();
server.closeAllConnections();
server.close();
rmSync(workspaceDir, { recursive: true, force: true });

// Real installer -> Codex -> MCP workbench -> new task -> follow-up, using a local model fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const root = process.env.QWEN_LD_TEST_PACKAGE
  ? path.resolve(process.env.QWEN_LD_TEST_PACKAGE)
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-provider-native-'));
const home = path.join(temp, 'home'),
  workspace = path.join(temp, 'parent');
fs.mkdirSync(home);
fs.mkdirSync(workspace);
const bin = process.env.CODEX_BIN || 'codex';
const env = {
  PATH: process.env.PATH,
  HOME: os.homedir(),
  CODEX_HOME: home,
  CODEX_BIN: bin,
  fixture_model_key: 'synthetic-local-fixture',
  FIXTURE_TENANT: 'local-test',
  QWEN_LD_WORKBENCH_STATE: path.join(temp, 'private'),
  QWEN_LD_WORKSPACE_ROOT: path.join(temp, 'workspaces'),
  QWEN_LD_PORT: '0',
  QWEN_LD_OPEN_BROWSER: 'never',
  QWEN_LD_BIND_HOST: '127.0.0.1',
};
let parent, cfg, parentRun, parentExit, failure, releaseParent;
let waitingForFeedback = false,
  interruptedResponseClosed = false;
const userScope = 'Use monochrome technical diagrams throughout the reference';
const parentGate = new Promise((resolve) => {
  releaseParent = resolve;
});
const calls = { parent: 0, first: 0, next: 0 };
const children = new Map();
async function until(read) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (failure) throw failure;
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Provider environment integration timed out');
}
const headers = () => ({
  Origin: `http://127.0.0.1:${cfg.port}`,
  Authorization: 'Bearer ' + cfg.accessToken,
  'Content-Type': 'application/json',
});
async function view(run) {
  return (
    await fetch(`http://127.0.0.1:${cfg.port}/live-delivery/api/state${run ? '?run=' + run : ''}`, {
      headers: headers(),
    })
  ).json();
}
async function post(route, body) {
  const state = await view();
  const response = await fetch(`http://127.0.0.1:${cfg.port}${route}`, {
    method: 'POST',
    headers: { ...headers(), 'X-CD-Token': state.csrfToken },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.ok, true, data.error);
  return data;
}
function reply(res, input, method, args, sequence) {
  const tools = (input.tools ?? []).flatMap((tool) =>
    tool.type === 'namespace'
      ? tool.tools.map((child) => ({ ...child, namespace: tool.name }))
      : [tool],
  );
  const tool = method ? tools.find((tool) => tool.name.endsWith(method)) : null;
  if (method) assert.ok(tool, 'Plugin MCP tool must be present');
  const item = method
    ? {
        type: 'function_call',
        id: 'fc_' + sequence,
        call_id: 'call_' + sequence,
        name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        arguments: JSON.stringify(args),
        status: 'completed',
      }
    : {
        type: 'message',
        id: 'msg_' + sequence,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Complete.', annotations: [] }],
      };
  const response = {
    id: 'resp_' + sequence,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: input.model,
    status: 'completed',
    output: [item],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
  };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let index = 0;
  const event = (type, fields) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: index++, ...fields })}\n\n`,
    );
  event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  event('response.output_item.added', {
    output_index: 0,
    item: method
      ? { ...item, arguments: '', status: 'in_progress' }
      : { ...item, content: [], status: 'in_progress' },
  });
  if (method) {
    event('response.function_call_arguments.delta', {
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    });
    event('response.function_call_arguments.done', {
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    });
  } else {
    event('response.content_part.added', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    event('response.output_text.delta', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: 'Complete.',
    });
    event('response.output_text.done', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: 'Complete.',
    });
    event('response.content_part.done', {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    });
  }
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', { response });
  res.end();
}
const model = createServer(async (req, res) => {
  try {
    if (!req.url.includes('responses')) {
      res.end('{}');
      return;
    }
    assert.equal(req.headers.authorization, 'Bearer ' + env.fixture_model_key);
    assert.equal(req.headers['x-fixture-tenant'], env.FIXTURE_TENANT);
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body),
      text = JSON.stringify(input.input);
    const key = text.includes('PROVIDER-ROUND-TWO')
      ? 'next'
      : text.includes('PROVIDER-ROUND-ONE')
        ? 'first'
        : 'parent';
    const step = calls[key]++;
    assert.ok(step < (key === 'first' ? 7 : 4), 'Unexpected fixture model continuation');
    let method, args;
    if (key === 'parent') {
      if (step === 0) {
        method = 'ld_status';
        args = {};
      }
      if (step === 1) {
        await parentGate;
        method = 'ld_done';
        args = { summary: 'Parent fixture complete' };
      }
    } else {
      const run = await until(() => children.get(key));
      if (step === 0) {
        method = 'ld_begin';
        args = {
          task: key === 'first' ? 'PROVIDER-ROUND-ONE' : 'PROVIDER-ROUND-TWO',
          milestones: [
            {
              id: 'usable',
              title: 'Offline page',
              scope: 'Usable offline page',
              acceptance: ['Opens offline'],
              target_after: '1m',
            },
          ],
        };
      }
      if (key === 'first' && step === 2) {
        // Hold a real response open so feedback must interrupt it. Do not
        // consume the next tool call on a response that Codex has cancelled.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': waiting for user feedback\n\n');
        res.on('close', () => {
          interruptedResponseClosed = true;
        });
        waitingForFeedback = true;
        return;
      }
      if (step === 1 || (key === 'first' && step === 4)) {
        if (step === 4)
          assert.ok(text.includes(userScope), 'Chat feedback must reach the actual Codex context');
        const state = await view(run.runId);
        const dir = path.join(state.workbench.workspace.path, 'output');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'index.html'),
          '<h1>Usable ' + key + ' artifact ' + (step === 4 ? userScope : '') + '</h1>',
        );
        method = 'ld_publish';
        args = {
          paths: ['output'],
          preview_entry: 'output/index.html',
          milestone_id: step === 4 ? 'user-added' : 'usable',
          plan_revision: state.planReview.revision,
          checks: [{ label: 'Opens offline', result: 'passed' }],
        };
      }
      if (key === 'first' && step === 3) {
        assert.ok(text.includes(userScope), 'Interrupted turn must resume with user feedback');
        const state = await view(run.runId);
        method = 'ld_begin';
        args = {
          task: state.task.request,
          plan_revision: state.planReview.revision,
          next_milestone: {
            id: 'user-added',
            title: 'Requested comparison',
            scope: userScope,
            acceptance: ['Opens offline'],
            target_after: '90s',
          },
        };
      }
      if ((key === 'first' && step === 5) || (key === 'next' && step === 2)) {
        const state = await view(run.runId);
        await post(state.controlBase + '/api/wrap-up', { session_id: state.task.id });
        method = 'ld_done';
        args = { summary: 'Complete ' + key };
      }
    }
    reply(res, input, method, args, key + '_' + step);
  } catch (error) {
    failure = error;
    res.writeHead(500);
    res.end('{}');
  }
});
try {
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `model="fixture-model"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${model.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nenv_key="fixture_model_key"\nrequest_max_retries=0\nstream_max_retries=0\n[model_providers.fixture.env_http_headers]\nX-Fixture-Tenant="FIXTURE_TENANT"\n`,
  );
  const install = spawnSync(
    process.execPath,
    [path.join(root, 'dist/setup.mjs'), '--yes', '--install-only', '--workspace', workspace],
    { env, cwd: workspace, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const packages = path.join(home, 'live-delivery/packages');
  const manifest = fs.readFileSync(
    path.join(packages, fs.readdirSync(packages)[0], '.mcp.json'),
    'utf8',
  );
  assert.ok(manifest.includes('fixture_model_key'));
  assert.ok(!manifest.includes(env.fixture_model_key));
  parent = spawn(
    bin,
    [
      'exec',
      '--cd',
      workspace,
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '--json',
      '-',
    ],
    { env, cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  parent.stdout.resume();
  parent.stderr.resume();
  parentExit = new Promise((resolve) => parent.on('exit', resolve));
  parent.stdin.end('$ld:go PROVIDER-PARENT');
  cfg = await until(() => {
    const dir = path.join(workspace, '.live-delivery/_runtime');
    if (!fs.existsSync(dir)) return null;
    for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.config.json'))) {
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (value.port > 0 && value.accessToken) return value;
    }
  });
  parentRun = (await view()).workbench.selectedRun;
  const created = await post('/live-delivery/api/workspaces', { name: 'provider-case' });
  let previous;
  for (const key of ['first', 'next']) {
    const run = await post('/live-delivery/api/tasks', {
      id: 'provider-' + key,
      workspaceId: created.workspace.id,
      query: key === 'first' ? 'PROVIDER-ROUND-ONE' : 'PROVIDER-ROUND-TWO',
      timeBudgetSec: 120,
      ...(previous ? { parentRunId: previous.runId } : {}),
    });
    children.set(key, run);
    if (key === 'first') {
      const initial = await until(async () => {
        const state = await view(run.runId);
        return state.releases?.length === 1 ? state : null;
      });
      await until(() => waitingForFeedback);
      await post(initial.controlBase + '/api/feedback', {
        session_id: initial.task.id,
        id: 'provider-feedback',
        text: userScope,
      });
    }
    const state = await until(async () => {
      const state = await view(run.runId);
      if (state.workbench?.runs?.find((item) => item.id === run.taskId)?.status === 'failed')
        throw Error('Browser Codex task failed');
      return state.task?.status === 'done' &&
        !state.workbench.workspaces.find((item) => item.id === created.workspace.id).busy
        ? state
        : null;
    });
    assert.equal(state.releases.at(-1).version, key === 'first' ? 2 : 3);
    previous = run;
  }
  const state = await view(parentRun);
  await post(state.controlBase + '/api/wrap-up', { session_id: state.task.id });
  releaseParent();
  assert.equal(
    await Promise.race([
      parentExit,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 10000)),
    ]),
    0,
  );
  assert.ok(calls.parent > 0 && calls.first > 0 && calls.next > 0);
  assert.ok(interruptedResponseClosed, 'Feedback must cancel the pending model response');
  console.log(
    'PASS: arbitrary lowercase provider key and header variable reached real Codex through installation, parent MCP, browser task and follow-up; chat feedback reached Codex and delivered V2; follow-up delivered V3; manifest contains names only.',
  );
} finally {
  releaseParent();
  if (parent && parent.exitCode === null) parent.kill('SIGTERM');
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}

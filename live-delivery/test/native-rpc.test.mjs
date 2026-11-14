import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { NativeRpc } from '../.test-build/native-rpc.js';

test('unexpected JSON output cannot crash the native RPC client', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cd-rpc-'));
  const bin = path.join(dir, 'fixture.mjs');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  process.stdout.write('null\\n42\\n[]\\ninvalid json\\n');
  process.stdout.write(JSON.stringify({ id: message.id, result: { ready: true } }) + '\\n');
});
`,
    { mode: 0o700 },
  );
  const rpc = new NativeRpc({ PATH: process.env.PATH }, dir, bin);
  t.after(async () => {
    const exited = once(rpc.child, 'exit');
    rpc.close();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await rpc.call('check', {}), { ready: true });
});

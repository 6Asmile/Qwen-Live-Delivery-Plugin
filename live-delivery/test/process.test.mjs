import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  parseLinuxStartTime,
  parseDarwinStartTime,
  processStartTime,
} from '../.test-build/process.js';

test('Linux process identities preserve saved ticks and reject zombie records', () => {
  const fields = ['S', ...Array(18).fill('0'), '43812759', '0'];
  assert.equal(parseLinuxStartTime(`12 (name with ) spaces) ${fields.join(' ')}`), '43812759');
  fields[0] = 'Z';
  assert.equal(parseLinuxStartTime(`12 (codex) ${fields.join(' ')}`), undefined);
  assert.equal(parseLinuxStartTime('truncated'), undefined);
});

test('macOS process identities handle BSD status flags, spacing, and PID reuse', () => {
  assert.equal(
    parseDarwinStartTime('Ss+  Sat Nov  7 01:02:03 2026\n'),
    'ps:Sat Nov 7 01:02:03 2026',
  );
  assert.notEqual(
    parseDarwinStartTime('S Sat Nov 7 01:02:03 2026'),
    parseDarwinStartTime('S Sat Nov 7 01:02:04 2026'),
  );
  assert.equal(parseDarwinStartTime('Z Sat Nov 7 01:02:03 2026'), undefined);
  assert.equal(parseDarwinStartTime(''), undefined);
  assert.equal(parseDarwinStartTime('S invalid timestamp'), undefined);
});

test('native and ps process queries track a child until it exits', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'pipe',
  });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  try {
    const identity = processStartTime(child.pid);
    assert.ok(identity);
    assert.equal(processStartTime(child.pid), identity);
    // These ps fields are supported by BSD and GNU ps. macOS CI exercises BSD ps.
    const psIdentity = processStartTime(child.pid, 'darwin');
    assert.ok(psIdentity?.startsWith('ps:'));
    assert.equal(processStartTime(child.pid, 'darwin'), psIdentity);
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
  assert.equal(processStartTime(child.pid), undefined);
  assert.equal(processStartTime(child.pid, 'darwin'), undefined);
});

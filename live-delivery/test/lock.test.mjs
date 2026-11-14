import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withLock } from '../.test-build/lock.js';

function setup(t) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'cd-lock-test-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const lock = path.join(workspace, '.live-delivery/_write.lock');
  mkdirSync(lock, { recursive: true });
  return { workspace, lock };
}
function age(lock) {
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
}

test('recovers an abandoned empty lock and records the current owner', (t) => {
  const { workspace, lock } = setup(t);
  age(lock);
  assert.equal(
    withLock(workspace, () => {
      assert.equal(readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid));
      return 'published';
    }),
    'published',
  );
  assert.equal(existsSync(lock), false);
});

test('recovers a lock whose recorded process has exited', (t) => {
  const { workspace, lock } = setup(t);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const pid = Number(child.stdout);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  writeFileSync(path.join(lock, 'pid'), String(pid));
  assert.equal(
    withLock(workspace, () => 42),
    42,
  );
  assert.equal(existsSync(lock), false);
});

test('preserves a fresh empty lock while another owner may still be writing its PID', (t) => {
  const { workspace, lock } = setup(t);
  assert.throws(
    () => withLock(workspace, () => assert.fail('must not acquire')),
    /CD state is busy/,
  );
  assert.deepEqual(readdirSync(lock), []);
});

test('preserves a live owner even when its lock is old', (t) => {
  const { workspace, lock } = setup(t);
  writeFileSync(path.join(lock, 'pid'), String(process.pid));
  age(lock);
  assert.throws(
    () => withLock(workspace, () => assert.fail('must not acquire')),
    /CD state is busy/,
  );
  assert.equal(readFileSync(path.join(lock, 'pid'), 'utf8'), String(process.pid));
});

test('does not delete an unknown nonempty lock', (t) => {
  const { workspace, lock } = setup(t);
  writeFileSync(path.join(lock, 'unknown-owner'), 'preserve');
  age(lock);
  assert.throws(
    () => withLock(workspace, () => assert.fail('must not acquire')),
    /CD state is busy/,
  );
  assert.equal(readFileSync(path.join(lock, 'unknown-owner'), 'utf8'), 'preserve');
});

test('releases the lock after an operation throws, allowing the next publish', (t) => {
  const { workspace, lock } = setup(t);
  rmSync(lock, { recursive: true });
  assert.throws(
    () =>
      withLock(workspace, () => {
        throw new Error('publish failed');
      }),
    /publish failed/,
  );
  assert.equal(existsSync(lock), false);
  assert.equal(
    withLock(workspace, () => 'next publish'),
    'next publish',
  );
});

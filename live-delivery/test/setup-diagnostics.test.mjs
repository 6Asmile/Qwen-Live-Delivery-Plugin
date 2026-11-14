import assert from 'node:assert/strict';
import test from 'node:test';
import { sandboxWarnings } from '../.test-build/setup-diagnostics.js';

test('installation diagnoses a disabled Linux user namespace without claiming other hosts work', () => {
  const inspect = (readLimit) => sandboxWarnings({ platform: 'linux', env: {}, readLimit });
  assert.deepEqual(
    inspect(() => '0\n').map((w) => w.code),
    ['user-namespaces-disabled'],
  );
  assert.deepEqual(
    inspect(() => '1024\n'),
    [],
  );
  assert.deepEqual(
    inspect(() => {
      throw new Error('unreadable');
    }),
    [],
  );
});

test('macOS installation does not attempt to read Linux sysctls', () => {
  assert.deepEqual(
    sandboxWarnings({
      platform: 'darwin',
      env: {},
      readLimit: () => assert.fail('must not read /proc on macOS'),
    }),
    [],
  );
});

test('explicit full access is warned about without mutating the environment or probing a sandbox', () => {
  const env = Object.freeze({ QWEN_LD_TASK_SANDBOX: 'danger-full-access' });
  const warnings = sandboxWarnings({
    platform: 'linux',
    env,
    readLimit: () => assert.fail('namespace quota is irrelevant when sandbox is disabled'),
  });
  assert.deepEqual(
    warnings.map((w) => w.code),
    ['full-access'],
  );
  assert.equal(env.QWEN_LD_TASK_SANDBOX, 'danger-full-access');
});

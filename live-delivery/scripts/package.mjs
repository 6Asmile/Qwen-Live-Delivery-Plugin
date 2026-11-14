import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  rmSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { checkFileList, npm, root, pluginRoot, runtimeFiles } from './check-release.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) {
  throw new Error('Usage: npm run package -- --out /path/to/release-directory');
}
const output = path.resolve(args[1] || path.join(pluginRoot, 'release'));
const within = (directory, target) => {
  const relative = path.relative(directory, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};
if (
  within(root, output) &&
  !within(path.join(root, 'release'), output) &&
  !within(path.join(pluginRoot, 'release'), output)
) {
  throw new Error('Keep archives outside source, or under the ignored release/ directory.');
}
const pkg = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
const archive = path.join(output, `${pkg.name}-${pkg.version}.tgz`);
const checksum = path.join(output, 'SHA256SUMS');
if (existsSync(archive) || existsSync(checksum))
  throw new Error('Output already exists; choose a fresh release directory.');
mkdirSync(output, { recursive: true });
const pack = npm(['pack', '--dry-run', '--ignore-scripts', '--json']);
checkFileList(pack.files);
const staging = mkdtempSync(path.join(tmpdir(), 'ld-release-'));
try {
  for (const file of runtimeFiles) {
    const destination = path.join(staging, 'package', file);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, file), destination);
  }
  const built = path.join(staging, 'release.tgz');
  const result = spawnSync(
    'tar',
    ['-czf', built, '-C', staging, ...[...runtimeFiles].map((file) => `package/${file}`)],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  copyFileSync(built, archive, constants.COPYFILE_EXCL);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
assert.equal(listing.status, 0, listing.stderr);
assert.deepEqual(
  listing.stdout.trim().split('\n').sort(),
  [...runtimeFiles].map((name) => `package/${name}`).sort(),
);
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(checksum, `${digest}  ${path.basename(archive)}\n`, { flag: 'wx' });
console.log(
  `Created ${archive}\nSHA-256: ${digest}\nOnly runtime and public documentation are included.`,
);

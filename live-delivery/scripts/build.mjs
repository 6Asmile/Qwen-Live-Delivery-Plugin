import { build } from 'esbuild';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dependencyNotices } from './licenses.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
copyFileSync(path.join(root, '../LICENSE'), path.join(root, 'LICENSE'));
if (process.argv.slice(2).some((value) => value !== 'codex'))
  throw new Error('This package builds the Codex adapter only.');
const descriptions = JSON.parse(
  readFileSync(path.join(root, 'src/prompts/tool-descriptions.json'), 'utf8'),
);
writeFileSync(
  path.join(root, 'src/prompts.generated.ts'),
  "// Generated from this package's src/prompts/tool-descriptions.json.\nexport const TOOL_DESCRIPTIONS = " +
    JSON.stringify(descriptions, null, 2) +
    ' as const;\n',
);

const assetTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};
const assets = {};
function collectAssets(dir, prefix = '') {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + item.name;
    if (item.isDirectory()) collectAssets(path.join(dir, item.name), rel + '/');
    else
      assets[rel] = {
        type: assetTypes[path.extname(item.name)] || 'application/octet-stream',
        body: readFileSync(path.join(dir, item.name)).toString('base64'),
      };
  }
}
await build({
  entryPoints: [path.join(root, 'src/budget.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'QWEN_LD_BUDGET',
  target: 'es2022',
  outfile: path.join(root, 'ui/budget.generated.js'),
});
collectAssets(path.join(root, 'ui'));
writeFileSync(
  path.join(root, 'src/ui-assets.generated.ts'),
  '// Generated from ui/. No workspace data.\nexport const UI_ASSETS: Record<string, {type:string;body:string}> = ' +
    JSON.stringify(assets) +
    ';\n',
);

const options = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  define: { QWEN_LD_HARNESS: JSON.stringify('codex') },
  legalComments: 'eof',
};
const bundledPackages = new Set();
for (const entry of ['server', 'hook', 'viewer', 'workbench', 'setup']) {
  const result = await build({
    ...options,
    metafile: true,
    absWorkingDir: root,
    entryPoints: [path.join(root, 'src', `${entry}.ts`)],
    outfile: path.join(root, 'dist', `${entry}.mjs`),
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
  const notices = dependencyNotices(root, Object.keys(result.metafile.inputs));
  appendFileSync(path.join(root, 'dist', `${entry}.mjs`), notices.comment);
  for (const id of notices.packages) bundledPackages.add(id);
}
console.log(`Embedded license notices for ${bundledPackages.size} bundled dependencies.`);
rmSync(path.join(root, '.test-build'), { recursive: true, force: true });
await build({
  ...options,
  entryPoints: [
    'core',
    'budget',
    'activity',
    'engine',
    'state',
    'config',
    'model',
    'policy',
    'tools',
    'usage',
    'lock',
    'publication',
    'timeline',
    'controls',
    'feedback-handoff',
    'read-model',
    'http',
    'request-body',
    'process',
    'access',
    'registry',
    'hook-trust',
    'browser',
    'workbench-host',
    'native-rpc',
    'setup-diagnostics',
    'instructions',
    'prior-context',
    'provider-env',
  ].map((name) => path.join(root, 'src', `${name}.ts`)),
  outdir: path.join(root, '.test-build'),
});
console.log('Built self-contained Codex MCP server and hooks; no sibling repository required.');

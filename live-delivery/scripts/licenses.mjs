import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Collect the packages actually bundled, rather than every development dependency.
export function dependencyNotices(root, inputs) {
  const packages = new Map();
  for (const input of inputs) {
    const matches = [
      ...input.replaceAll('\\', '/').matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/g),
    ];
    const match = matches.at(-1);
    if (!match) continue;
    const directory = path.resolve(root, input.slice(0, match.index + match[0].length));
    const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const id = `${metadata.name}@${metadata.version}`;
    if (packages.has(id)) continue;
    const licenses = readdirSync(directory).filter((name) =>
      /^(licen[cs]e|copying|notice)(\.|$)/i.test(name),
    );
    if (!licenses.length) throw new Error(`Missing bundled dependency license: ${id}`);
    packages.set(id, {
      ...metadata,
      licenses: licenses
        .sort()
        .map((name) => ({ name, text: readFileSync(path.join(directory, name), 'utf8').trim() })),
    });
  }
  let text =
    'Qwen Live Delivery Plugin\nCopyright (c) 2026 Qwen Live Delivery Plugin contributors\n\nProject code is licensed under Apache-2.0. Bundled components retain their own licenses below.\n';
  if (inputs.some((input) => input.replaceAll('\\', '/').endsWith('src/ui-assets.generated.ts'))) {
    text +=
      '\nUI assets\n\nQwen mark: excluded from the project Apache-2.0 license. No trademark rights or endorsement are granted.\n\nPlus Jakarta Sans\n\n';
    text +=
      readFileSync(path.join(root, 'ui/assets/fonts/PlusJakartaSans-OFL.txt'), 'utf8').trim() +
      '\n';
  }
  text += '\nBundled JavaScript dependencies\n';
  for (const [id, pkg] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    text += `\n${id}\n\nLicense: ${pkg.license ?? 'See license text below'}.\n`;
    for (const license of pkg.licenses) text += `\n${license.name}:\n\n${license.text}\n`;
  }
  // Line comments also safely carry license text containing block-comment delimiters.
  return {
    packages: [...packages.keys()],
    comment:
      '\n' +
      text
        .split('\n')
        .map((line) => ('// ' + line).trimEnd())
        .join('\n') +
      '\n',
  };
}

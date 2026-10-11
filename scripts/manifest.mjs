import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const write = process.argv.includes('--write');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'))).version;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const name of ['MuTools', 'MuGovernance']) {
  const source = resolve(root, `contracts/ecosystem/contracts/${name}.sol`);
  const target = resolve(root, `release/sources/ecosystem/${name}.sol`);
  if (write) copyFileSync(source, target);
  if (hash(readFileSync(source)) !== hash(readFileSync(target))) throw Error(`Stale source export: ${name}`);
}
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = resolve(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
const files = Object.fromEntries(walk(resolve(root, 'release')).sort()
  .filter(p => !p.endsWith('manifest.json'))
  .map(p => [relative(resolve(root, 'release'), p).replaceAll('\\', '/'), hash(readFileSync(p))]));
const manifest = { schemaVersion: 1, version, files };
const output = JSON.stringify(manifest, null, 2) + '\n';
const path = resolve(root, 'release/manifest.json');
if (write) writeFileSync(path, output);
else if (readFileSync(path, 'utf8') !== output) throw Error('Release manifest differs; review exports and run npm run release:prepare');
console.log(`Verified ${Object.keys(files).length} release files for ${version}`);

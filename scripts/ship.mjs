// Publish reviewed source only. No wallet, RPC writes, or app deployment.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const run = (cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const git = (...args) => run('git', args);
const repo = 'mucoindev/mu-contracts';
if (git('status', '--porcelain')) throw Error('Commit reviewed changes before releasing');
run(process.execPath, ['scripts/manifest.mjs']);
const commit = git('rev-parse', 'HEAD');
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Expected a stable semver version');
const tag = `v${version}`;
git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', 'HEAD:main');
const deadline = Date.now() + 25 * 60 * 1000;
let green = false;
while (Date.now() < deadline) {
  const runs = JSON.parse(run('gh', ['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--commit', commit, '--event', 'push', '--json', 'status,conclusion,url', '--limit', '1']));
  const check = runs[0];
  if (check?.status === 'completed') {
    if (check.conclusion !== 'success') throw Error(`Contract CI ${check.conclusion}: ${check.url}`);
    green = true;
    break;
  }
  console.log(`Waiting for contract CI on ${commit.slice(0, 8)}`);
  await new Promise(r => setTimeout(r, 15000));
}
if (!green) throw Error('CI timeout; no release published');
const remoteTag = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
if (remoteTag && remoteTag.split(/\s/)[0] !== commit) throw Error('Version already belongs to another commit');
console.log(run('gh', ['release', 'create', tag, '--repo', repo, '--target', commit, '--title', `MU contracts ${tag}`, '--notes-file', 'RELEASE.md']));
console.log(`Committed ${commit}; published ${tag}. No chain transactions.`);

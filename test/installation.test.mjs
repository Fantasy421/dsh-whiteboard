import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('installation instructions point at our prebuilt release, not the unrelated npm namesake', async () => {
  const readme = await readFile(new URL('README.md', root), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const tarball = `https://github.com/Fantasy421/dsh-whiteboard/releases/download/v${pkg.version}/dsh-whiteboard-${pkg.version}.tgz`;
  assert.ok(readme.includes(tarball), 'the public install entry must be a version-pinned prebuilt release');
  assert.match(readme, /npm.*同名.*0\.0\.1/u, 'warn about the known registry namesake instead of suggesting a bare name');
  assert.match(readme, /dsh plugin --profile desktop add https:\/\/github\.com\/Fantasy421\/dsh-whiteboard\/releases\/download\//u);
});

test('the plugin declares the bundle patch that the installer actually requires', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  const patch = await readFile(new URL(pkg.dsh.bundle.patch, root), 'utf8');
  assert.match(patch, /- insert:/u);
  assert.match(patch, /name: dsh-whiteboard/u);
  assert.equal(pkg.main, './lib/index.js');
  assert.ok(pkg.files.includes('lib'));
});

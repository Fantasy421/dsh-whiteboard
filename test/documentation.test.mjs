import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { exampleDefinitions, buildExample } from '../scripts/generate-examples.mjs';
import { validateScene } from '../src/model.mjs';
import { readingNeighborhood } from '../src/reading.mjs';

const root = new URL('../', import.meta.url);
test('fictional editable examples match deterministic model output and operation definitions', async () => {
  for (const definition of exampleDefinitions) {
    const saved = JSON.parse(await readFile(new URL(`examples/${definition.id}.excalidraw`, root), 'utf8'));
    assert.deepEqual(saved, buildExample(definition));
    assert.deepEqual(JSON.parse(await readFile(new URL(`examples/${definition.id}.operations.json`, root), 'utf8')), definition.operations);
    assert.equal(saved.type, 'excalidraw');
    assert.equal(saved.version, 2);
    assert.ok(validateScene({ elements: saved.elements, files: saved.files, selectedIds: [] }));
    assert.doesNotMatch(JSON.stringify(saved), /\/Users\/|\/home\/|session-d6f0b0d9/u);
  }
});

test('reading demo has explicit one-hop bindings and an unrelated comparison node', () => {
  const scene = buildExample(exampleDefinitions[0]);
  const neighborhood = readingNeighborhood(scene.elements, 'validate');
  assert.deepEqual(new Set(neighborhood.nodeIds), new Set(['input', 'validate', 'complete']));
  assert.deepEqual(new Set(neighborhood.edgeIds), new Set(['input-validation', 'validation-complete']));
  assert.ok(!neighborhood.highlightIds.includes('note'));
  const architecture = buildExample(exampleDefinitions[1]);
  assert.ok(architecture.elements.some(el => el.type === 'arrow' && el.roundness?.type === 2));
  assert.ok(architecture.elements.some(el => el.type === 'arrow' && !el.roundness && el.points.length > 2));
});

test('front page distinguishes unrecorded GUI demos from generated fixtures and ships its documentation', async () => {
  const readme = await readFile(new URL('README.md', root), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.match(readme, /真实 GIF 尚未录制/u);
  assert.match(readme, /代码构建.*虚构/u);
  assert.match(readme, /不是.*Computer Use 实录/u);
  assert.ok(pkg.files.includes('docs/*.md'));
  assert.ok(pkg.files.includes('examples'));
  assert.doesNotMatch(readme, /!\[[^\]]*\]\([^)]*\.gif\)/u, 'do not publish nonexistent recording placeholders');
});

test('relative links in README and extracted documentation resolve inside the repository', async () => {
  const paths = ['README.md', 'examples/README.md', ...(await readdir(new URL('docs/', root))).filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
  let links = 0;
  for (const path of paths) {
    const file = new URL(path, root);
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/gu)) {
      const href = match[1].replace(/^<|>$/gu, '');
      if (/^[a-z][a-z\d+.-]*:|^#/iu.test(href)) continue;
      const destination = new URL(href, file);
      destination.hash = '';
      assert.ok(destination.href.startsWith(root.href), `${path}: relative link escapes repository`);
      assert.ok((await stat(destination)).isFile(), `${path}: missing ${href}`);
      links++;
    }
  }
  assert.ok(links > 40);
});

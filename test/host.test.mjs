import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

test('host adapter registers session-owned AI tools and authenticated-carrier route', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wb-host-'));
  t.after(async () => { if (!directory.startsWith(join(tmpdir(), 'dsh-wb-host-'))) throw new Error('Unsafe cleanup'); await rm(directory, { recursive: true }); });
  await writeFile(join(directory, 'assets-manifest.json'), '[]');
  // Mock only the registration helper, not the store/model/tool implementations.
  // import.meta.url is fixed to a test-owned assets location without creating a host module file.
  const result = await build({ entryPoints: [new URL('../src/index.mjs', import.meta.url).pathname], write: false, bundle: true, platform: 'node', format: 'esm',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(directory, 'index.js')).href) },
    plugins: [{ name: 'test-sdk', setup(b) {
      b.onResolve({ filter: /^@deepseek-ai\/dsh-tools$/ }, () => ({ path: 'sdk', namespace: 'test-sdk' }));
      b.onLoad({ filter: /.*/, namespace: 'test-sdk' }, () => ({ contents: 'export const defineTool = tool => tool;', loader: 'js' }));
    } }],
  });
  const host = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const tools = new Map(), routes = [];
  await host.apply({ effect: f => f(), tools: { register(tool) { tools.set(tool.name, tool); return () => {}; } }, connection: { fetch: { register(route) { routes.push(route); return () => {}; } } } }, { directory: join(directory, 'boards') });
  assert.deepEqual(host.inject, ['tools', 'connection']);
  assert.deepEqual([...tools.keys()], ['whiteboard_read', 'whiteboard_patch']);
  assert.equal(routes[0].path, '/api/dsh-whiteboard');
  const exec = sessionId => ({ agent: { session: { id: sessionId } }, signal: new AbortController().signal });
  const read = tools.get('whiteboard_read'), patch = tools.get('whiteboard_patch');
  await assert.rejects(() => read.execute({}, {}), /owning agent/);
  const initial = await read.execute({}, exec('alice'));
  assert.equal(initial.revision, 0);
  const added = await patch.execute({ baseRevision: 0, operations: [{ op: 'add', id: 'api', type: 'rectangle', x: 20, y: 20, text: 'API' }] }, exec('alice'));
  assert.equal(added.revision, 1); assert.ok(added.elements.some(e => e.text === 'API'));
  assert.equal((await read.execute({}, exec('bob'))).elements.length, 0);
  await assert.rejects(() => patch.execute({ baseRevision: 0, operations: [{ op: 'delete', id: 'api' }] }, exec('alice')), /whiteboard_read again/);
  const rendered = read.output.render({}, added); assert.equal(rendered[0].type, 'text');
  assert.equal(JSON.parse(rendered[0].text).revision, 1);
});

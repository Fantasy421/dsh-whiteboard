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
  assert.deepEqual([...tools.keys()], ['whiteboard_read', 'whiteboard_patch', 'whiteboard_list', 'whiteboard_manage']);
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
  assert.deepEqual(patch.parameters.operations.items.properties.lineStyle.enum, ['straight', 'curved', 'polyline']);
  const routed = await patch.execute({ baseRevision: 1, operations: [{ op: 'add', id: 'curved', type: 'line', x: 10, y: 180, width: 200, lineStyle: 'curved' }, { op: 'add', id: 'folded', type: 'line', x: 10, y: 300, points: [[0, 0], [80, 0], [80, 100], [200, 100]], lineStyle: 'polyline' }] }, exec('alice'));
  assert.equal(routed.revision, 2);
  const curve = routed.elements.find(e => e.id === 'curved');
  assert.equal(curve.roundness.type, 2); assert.ok(curve.points.length >= 3);
  assert.equal((await read.execute({}, exec('alice'))).elements.find(e => e.id === 'folded').points.length, 4);
  await assert.rejects(() => patch.execute({ baseRevision: 2, operations: [{ op: 'update', id: 'api', lineStyle: 'curved' }] }, exec('alice')), /Only arrows and lines accept lineStyle/);
  assert.equal((await read.execute({}, exec('alice'))).revision, 2);
  const rendered = read.output.render({}, added); assert.equal(rendered[0].type, 'text');
  assert.equal(JSON.parse(rendered[0].text).revision, 1);
  const list = tools.get('whiteboard_list'), manage = tools.get('whiteboard_manage');
  const catalog = await list.execute({}, exec('alice'));
  assert.equal(catalog.revision, 0); assert.equal(catalog.activeBoardId, 'default');
  assert.equal(initial.boardId, 'default');
  const created = await manage.execute({ action: 'create', baseRevision: 0 }, exec('alice'));
  const other = created.activeBoardId;
  assert.notEqual(other, 'default'); assert.equal(created.boards.length, 2);
  assert.equal((await read.execute({}, exec('alice'))).boardId, other);
  await assert.rejects(() => patch.execute({ baseRevision: 0, operations: [] }, exec('alice')), /Explicit boardId/);
  const targeted = await patch.execute({ boardId: other, baseRevision: 0, operations: [{ op: 'add', id: 'other-only', type: 'text', text: 'Second board' }] }, exec('alice'));
  assert.equal(targeted.boardId, other); assert.equal(targeted.revision, 1);
  assert.equal((await read.execute({ boardId: 'default' }, exec('alice'))).revision, 2);
  const renamed = await manage.execute({ action: 'rename', boardId: other, name: 'System design', baseRevision: 1 }, exec('alice'));
  assert.equal(renamed.boards.find(b => b.id === other).name, 'System design');
  const activated = await manage.execute({ action: 'activate', boardId: 'default', baseRevision: 2 }, exec('alice'));
  assert.equal(activated.activeBoardId, 'default');
  await assert.rejects(() => manage.execute({ action: 'create', name: 'stale', baseRevision: 2 }, exec('alice')), e => e.code === 'catalog-conflict' && e.catalog.revision === 3);
  assert.equal((await list.execute({}, exec('bob'))).boards.length, 1);
  await assert.rejects(() => read.execute({ boardId: other }, exec('bob')), /does not exist/);
  const deleted = await manage.execute({ action: 'delete', boardId: other, baseRevision: 3 }, exec('alice'));
  assert.equal(deleted.boards.length, 1);
  await assert.rejects(() => patch.execute({ boardId: other, baseRevision: 1, operations: [] }, exec('alice')), /deleted/);
  await assert.rejects(() => manage.execute({ action: 'delete', boardId: 'default', baseRevision: 4 }, exec('alice')), /last whiteboard/);
});

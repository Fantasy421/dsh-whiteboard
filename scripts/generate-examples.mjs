import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { emptyBoard, applyOperations, validateScene } from '../src/model.mjs';

// Fictional fixtures only: never reads a DSH profile, session, browser or user board.
const node = (id, text, x, y, backgroundColor = '#e7f5ff') => ({ op: 'add', id, type: 'rectangle', text, x, y, width: 180, height: 90, backgroundColor });
const arrow = (id, startId, endId, lineStyle = 'straight') => ({ op: 'add', id, type: 'arrow', startId, endId, lineStyle });
export const exampleDefinitions = [
  { id: 'reading-flow', name: '演示·流程', operations: [
    node('input', '输入', 80, 100), node('validate', '校验', 360, 100, '#fff3bf'),
    node('complete', '完成', 640, 100, '#d3f9d8'), node('note', '备注（未连接）', 360, 310, '#f3f0ff'),
    arrow('input-validation', 'input', 'validate'), arrow('validation-complete', 'validate', 'complete'),
  ] },
  { id: 'system-architecture', name: '演示·架构', operations: [
    node('client', '界面', 80, 180), node('api', '服务', 380, 180, '#fff3bf'),
    node('storage', '本地存储', 680, 60, '#d3f9d8'), node('worker', '后台任务', 680, 300, '#f3f0ff'),
    arrow('client-api', 'client', 'api'), arrow('api-storage', 'api', 'storage', 'polyline'),
    arrow('api-worker', 'api', 'worker', 'curved'),
  ] },
  { id: 'human-ai-starter', name: '演示·接力编辑', operations: [node('requirement', '需求', 80, 150)] },
];
export function buildExample(definition) {
  const board = applyOperations(emptyBoard(`demo-${definition.id}`), definition.operations);
  for (const element of board.elements) {
    const value = createHash('sha256').update(element.id).digest().readUInt32BE(0) % 2147483646 + 1;
    element.seed = value;
    element.versionNonce = value;
    element.updated = 0;
  }
  const scene = validateScene(board);
  return { type: 'excalidraw', version: 2, source: 'https://github.com/Fantasy421/dsh-whiteboard',
    elements: scene.elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: scene.files };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = new URL('../examples/', import.meta.url);
  await mkdir(directory, { recursive: true });
  for (const definition of exampleDefinitions) {
    // Refuse to silently replace any existing sample or user file.
    await writeFile(new URL(`${definition.id}.excalidraw`, directory), JSON.stringify(buildExample(definition), null, 2) + '\n', { flag: 'wx' });
    await writeFile(new URL(`${definition.id}.operations.json`, directory), JSON.stringify(definition.operations, null, 2) + '\n', { flag: 'wx' });
    console.log(`Created fictional example: ${definition.id}`);
  }
}

import { build } from 'esbuild';
import { mkdir, writeFile, cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const lib = join(root, 'lib');
await mkdir(lib, { recursive: true });
const shared = { bundle: true, logLevel: 'info', sourcemap: false, legalComments: 'eof' };
await build({ ...shared, absWorkingDir: root, entryPoints: ['src/index.mjs'], outfile: 'lib/index.js', format: 'esm', platform: 'node', target: 'node20', packages: 'external' });
// Host-injected React singletons must never be bundled inside a client plugin.
await build({
  ...shared, absWorkingDir: root, entryPoints: ['src/client.jsx'], outfile: 'lib/client.js', format: 'cjs',
  platform: 'browser', target: ['chrome120', 'safari17'], conditions: ['production'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  loader: { '.css': 'text', '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
  minify: true,
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-whiteboard",factory:(require)=>{window.EXCALIDRAW_ASSET_PATH="/api/dsh-whiteboard-assets/";var module={exports:{}};var exports=module.exports;' },
  footer: { js: ';return module.exports;}});' },
});
const fonts = join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
// Liberation 1.05 in the npm release lacks a verified historical license notice;
// it is a server-render font, not needed by this browser plugin. Do not redistribute it.
await cp(fonts, join(lib, 'assets/fonts'), { recursive: true, filter: path => !path.split('/').includes('Liberation') });
async function fontPaths(directory, prefix = 'fonts') {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'Liberation') continue;
    if (entry.isDirectory()) paths.push(...await fontPaths(join(directory, entry.name), `${prefix}/${entry.name}`));
    else if (entry.name.endsWith('.woff2')) paths.push(`${prefix}/${entry.name}`);
  }
  return paths;
}
await writeFile(join(lib, 'assets-manifest.json'), JSON.stringify(await fontPaths(fonts), null, 2) + '\n');
// Preserve complete installed dependency license/notice files, in addition to
// minifier-preserved legal comments. Include dev notices too rather than omit one.
async function dependencyNotices(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name), relative = join(prefix, entry.name);
    if (entry.name.startsWith('@')) { await dependencyNotices(path, relative); continue; }
    for (const file of await readdir(path, { withFileTypes: true })) {
      if (file.isFile() && /^(?:licen[cs]e|copying|notice)(?:$|[.-])/i.test(file.name)) {
        const destination = join(lib, 'licenses/npm', relative);
        await mkdir(destination, { recursive: true });
        await cp(join(path, file.name), join(destination, file.name));
      } else if (file.isDirectory() && file.name === 'node_modules') await dependencyNotices(join(path, file.name), join(relative, 'node_modules'));
    }
  }
}
await dependencyNotices(join(root, 'node_modules'));
console.log('Built host + lazy CJS client + local fonts and dependency notices. No DSH profile was modified.');

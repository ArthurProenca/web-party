import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.join(root, 'extension');
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || !manifest.permissions.includes('offscreen')) {
  throw new Error('Manifest V3 e permissao offscreen sao obrigatorios.');
}
const entries = [manifest.background.service_worker, manifest.action.default_popup, 'offscreen.html',
  ...manifest.content_scripts.flatMap((script) => script.js)];
for (const entry of entries) await access(path.join(extension, entry));

let checked = 0;
for (const directory of ['extension', 'scripts', 'tests']) {
  const entries = await readdir(path.join(root, directory), { recursive: true });
  for (const entry of entries.filter((entry) => entry.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, entry)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
    checked++;
  }
}
for (const html of ['popup.html', 'offscreen.html']) {
  const content = await readFile(path.join(extension, html), 'utf8');
  for (const [, asset] of content.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) {
    await access(path.join(extension, asset));
  }
}
console.log(`Manifest, recursos e sintaxe de ${checked} arquivos JS validados.`);

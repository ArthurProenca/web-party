import './check.js';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'extension');
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const version = process.env.VERSION || manifest.version;
const dist = path.join(root, 'dist');
const unpacked = path.join(dist, 'chrome');
const archive = path.join(dist, `WebParty-chrome-v${version}.zip`);
await mkdir(dist, { recursive: true });
await rm(unpacked, { recursive: true, force: true });
await cp(source, unpacked, { recursive: true });
if (version !== manifest.version) {
  await writeFile(path.join(unpacked, 'manifest.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
}
await rm(archive, { force: true });
const result = spawnSync('zip', ['-qr', archive, '.'], { cwd: unpacked, stdio: 'inherit' });
if (result.error) throw new Error('Instale o utilitario zip para empacotar, ou carregue extension/ diretamente.');
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Pacote Chrome/Edge: ${path.relative(root, archive)}`);

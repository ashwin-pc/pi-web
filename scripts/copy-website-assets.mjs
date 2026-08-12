import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshots = resolve(root, 'tests/e2e/visual.spec.ts-snapshots');
const output = resolve(root, 'website/public/generated');

// Marketing may only consume maintained deterministic captures approved in
// docs/website-phase-one.md. Keep this list explicit so new snapshots never
// become website claims by accident.
const allowlist = [
  'artifacts-explorer-desktop.png',
  'artifacts-explorer-mobile.png',
  'artifact-preview-desktop.png',
  'artifact-preview-mobile.png',
  'workspace-explorer-desktop.png',
  'workspace-explorer-mobile.png',
  'git-diff-viewer-desktop.png',
  'git-diff-viewer-mobile.png',
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const filename of allowlist) {
  const source = resolve(snapshots, filename);
  try {
    const info = await stat(source);
    if (!info.isFile()) throw new Error('not a file');
  } catch (error) {
    console.error(`Required website capture is missing: ${source}`);
    throw error;
  }
  await copyFile(source, resolve(output, filename));
}

console.log(`Copied ${allowlist.length} approved website captures to ${output}`);

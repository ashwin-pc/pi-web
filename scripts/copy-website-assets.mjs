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
  'website-work-desktop.png',
  'website-work-mobile.png',
  'website-extension-desktop.png',
  'website-extension-mobile.png',
  'core-everyday-desktop.png',
  'core-everyday-mobile.png',
  'recommended-addons-desktop.png',
  'recommended-addons-mobile.png',
  'recommended-github-desktop.png',
  'recommended-github-mobile.png',
  'capability-tool-activity-desktop.png',
  'capability-tool-activity-mobile.png',
  'capability-transcript-recovery-desktop.png',
  'capability-transcript-recovery-mobile.png',
  'capability-queues-desktop.png',
  'capability-queues-mobile.png',
  'capability-attachments-desktop.png',
  'capability-attachments-mobile.png',
  'capability-models-context-desktop.png',
  'capability-models-context-mobile.png',
  'capability-branch-actions-desktop.png',
  'capability-branch-actions-mobile.png',
  'capability-mermaid-viewer-desktop.png',
  'capability-mermaid-viewer-mobile.png',
  'capability-notifications-desktop.png',
  'capability-notifications-mobile.png',
  'capability-device-handoff-desktop.png',
  'capability-device-handoff-mobile.png',
  'addon-notepad-desktop.png',
  'addon-notepad-mobile.png',
  'addon-github-desktop.png',
  'addon-github-mobile.png',
  'addon-recap-desktop.png',
  'addon-recap-mobile.png',
  'addon-artifact-reference-desktop.png',
  'addon-artifact-reference-mobile.png',
  'addon-git-footer-desktop.png',
  'addon-git-footer-mobile.png',
  'addon-session-orchestration-desktop.png',
  'addon-session-orchestration-mobile.png',
  'new-session-desktop.png',
  'new-session-mobile.png',
  'session-lanes-desktop.png',
  'session-lanes-mobile.png',
  'conversation-tree-desktop.png',
  'conversation-tree-mobile.png',
  'artifacts-explorer-desktop.png',
  'artifacts-explorer-mobile.png',
  'artifact-preview-desktop.png',
  'artifact-preview-mobile.png',
  'workspace-explorer-desktop.png',
  'workspace-explorer-mobile.png',
  'git-diff-viewer-desktop.png',
  'git-diff-viewer-mobile.png',
];

const animationAssets = [
  'new-chat-loading.webm',
  'new-chat-loading.mp4',
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function copyRequired(source, filename, kind) {
  try {
    const info = await stat(source);
    if (!info.isFile()) throw new Error('not a file');
  } catch (error) {
    console.error(`Required website ${kind} is missing: ${source}`);
    throw error;
  }
  await copyFile(source, resolve(output, filename));
}

for (const filename of allowlist) {
  await copyRequired(resolve(snapshots, filename), filename, 'capture');
}

for (const filename of animationAssets) {
  await copyRequired(resolve(root, 'public', filename), filename, 'welcome animation');
}

console.log(`Copied ${allowlist.length} approved website captures and ${animationAssets.length} welcome animation files to ${output}`);

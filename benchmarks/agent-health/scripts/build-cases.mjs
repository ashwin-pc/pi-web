#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceDir = join(root, 'cases');
const outputDir = resolve(process.argv[2] || join(root, 'generated'));

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function manifest(name) {
  const dir = join(root, 'fixtures', name);
  const all = await files(dir);
  const rows = [];
  const hash = createHash('sha256');
  let matches = 0;
  for (const path of all) {
    const bytes = await readFile(path);
    const rel = relative(dir, path).replaceAll('\\', '/');
    rows.push(`- \`${rel}\` — ${(await stat(path)).size} bytes`);
    hash.update(rel); hash.update('\0'); hash.update(bytes); hash.update('\0');
    if (/TODO|FIXME|\.skip\s*\(|(?:^|\/)tests?\//im.test(bytes.toString('utf8'))) matches++;
  }
  const authored = (await readFile(join(dir, 'FIXTURE.md'), 'utf8')).trim();
  const sha256 = hash.digest('hex');
  const scan = matches === 0 ? 'no markers found' : `${matches} file(s) matched`;
  return {
    sha256,
    markdown: `## Authored fixture notes\n\n${authored}\n\n## Generated inventory\n\n${rows.join('\n')}\n\n**Whole-fixture SHA-256:** \`${sha256}\`\n\n✅ Scanned for TODO / FIXME / test files / .skip markers — ${scan} in ${all.length} files.\n\nExact per-run fixture bytes and judge evidence are retained in the judge evidence \`workspace/\` directory.`,
  };
}

await mkdir(outputDir, { recursive: true });
for (const filename of (await readdir(sourceDir)).filter(f => f.endsWith('.json')).sort()) {
  const parsed = JSON.parse(await readFile(join(sourceDir, filename), 'utf8'));
  const cases = Array.isArray(parsed) ? parsed : [parsed];
  const built = [];
  for (const testCase of cases) {
    const context = testCase.context || [];
    const fixture = context.find(item => item.description === 'fixture');
    if (!fixture) { built.push(testCase); continue; }
    const info = await manifest(fixture.value);
    built.push({ ...testCase, context: [
      ...context.map(item => item === fixture ? { ...item, disposition: 'connector' } : item),
      { description: `Fixture manifest: ${fixture.value}`, value: info.markdown, disposition: 'documentation' },
    ]});
  }
  await writeFile(join(outputDir, filename), `${JSON.stringify(Array.isArray(parsed) ? built : built[0], null, 2)}\n`);
  console.log(`${basename(filename)}: ${built.length} case(s)`);
}

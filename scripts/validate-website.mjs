import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'site-dist');
const origin = 'https://ashwin-pc.github.io';
const base = '/pi-web/';

const expectedPages = {
  '/': [
    'The best interface for working with your agents.',
    'Current harness: pi',
  ],
  '/getting-started/': [
    'From install to your first agent session.',
    'There is no hosted account or relay in this setup.',
  ],
  '/features/': [
    'More work done. Every thread visible.',
    'In-progress foundation',
    'Current harness',
  ],
  '/features/work-from-anywhere/': [
    'Your agent workspace, on the screen you have.',
    'pi-web provides no hosted relay or identity service.',
  ],
  '/features/keep-the-thread/': [
    'Do more without losing the thread.',
    'Experimental · opt-in',
  ],
  '/features/rich-results/': [
    'Results you can see, inspect, and use.',
    'current default and full-capability reference harness',
  ],
  '/features/stay-in-control/': [
    'Stay close enough to trust the work.',
    'transport and network controls remain yours',
  ],
  '/extensions/': [
    'Describe the workflow. Ask your agent to add it.',
    'design direction, not something available extensions can target today',
  ],
  '/extensions/examples/': [
    'Start with a working extension. Make it yours.',
    'Experimental · opt-in',
  ],
  '/principles/': [
    'Built for agents that do real work.',
    'They are not multi-harness product support.',
  ],
};

const errors = [];
const pages = new Map();

function report(location, message) {
  errors.push(`${location}: ${message}`);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function routeFromFile(path) {
  const pathFromOutput = relative(output, path).split(sep).join('/');
  if (pathFromOutput === 'index.html') return '/';
  return `/${posix.dirname(pathFromOutput)}/`;
}

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const hex = entity[1].toLowerCase() === 'x';
    return String.fromCodePoint(Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

function visibleText(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return decodeEntities(body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function pageURL(route) {
  return new URL(`${base}${route === '/' ? '' : route.slice(1)}`, origin);
}

function references(html) {
  const found = [];
  for (const match of html.matchAll(/\b(href|src|poster)\s*=\s*(["'])(.*?)\2/gi)) {
    found.push({ attribute: match[1].toLowerCase(), value: decodeEntities(match[3]) });
  }
  for (const match of html.matchAll(/\bsrcset\s*=\s*(["'])(.*?)\1/gi)) {
    for (const candidate of decodeEntities(match[2]).split(',')) {
      const value = candidate.trim().split(/\s+/, 1)[0];
      if (value) found.push({ attribute: 'srcset', value });
    }
  }
  return found;
}

function fragmentTargets(html) {
  return new Set([...html.matchAll(/\b(?:id|name)\s*=\s*(["'])(.*?)\1/gi)].map((match) => decodeEntities(match[2])));
}

function localOutputPath(pathname) {
  if (pathname === base.slice(0, -1) || pathname === base) return join(output, 'index.html');
  const relativePath = pathname.slice(base.length);
  return pathname.endsWith('/')
    ? join(output, relativePath, 'index.html')
    : join(output, relativePath);
}

async function validateReference(route, reference, targetsByRoute) {
  const { attribute, value } = reference;
  if (!value || /^(?:data:|mailto:|tel:|javascript:)/i.test(value)) return;

  if (value.startsWith('/') && !value.startsWith(base)) {
    report(route, `${attribute}="${value}" is root-relative but does not include the ${base} base`);
    return;
  }

  let url;
  try {
    url = new URL(value, pageURL(route));
  } catch (error) {
    report(route, `invalid ${attribute} reference ${JSON.stringify(value)} (${error.message})`);
    return;
  }

  if (url.origin !== origin) return;
  if (url.pathname !== base.slice(0, -1) && !url.pathname.startsWith(base)) {
    report(route, `${attribute}="${value}" resolves outside the ${base} base (${url.pathname})`);
    return;
  }

  const targetPath = localOutputPath(url.pathname);
  try {
    await access(targetPath);
  } catch {
    report(route, `${attribute}="${value}" points to missing output ${relative(root, targetPath)}`);
    return;
  }

  if (!url.hash) return;
  let fragment;
  try {
    fragment = decodeURIComponent(url.hash.slice(1));
  } catch {
    report(route, `${attribute}="${value}" has an invalid encoded fragment`);
    return;
  }
  const targetRoute = routeFromFile(targetPath);
  const targets = targetsByRoute.get(targetRoute);
  if (!targets) {
    report(route, `${attribute}="${value}" has a fragment on a non-HTML resource`);
  } else if (!targets.has(fragment)) {
    report(route, `${attribute}="${value}" points to missing fragment #${fragment} on ${targetRoute}`);
  }
}

try {
  const files = await walk(output);
  for (const path of files.filter((file) => file.endsWith('.html'))) {
    const route = routeFromFile(path);
    pages.set(route, { html: await readFile(path, 'utf8'), path });
  }
} catch (error) {
  console.error(`Website output is unavailable at ${output}. Run \`npm run website:build\` first.`);
  console.error(error.message);
  process.exit(1);
}

for (const route of Object.keys(expectedPages)) {
  if (!pages.has(route)) report(route, `missing expected page (${relative(root, localOutputPath(pageURL(route).pathname))})`);
}
for (const route of pages.keys()) {
  if (!(route in expectedPages)) report(route, 'unexpected HTML route in built output');
}

const targetsByRoute = new Map(
  [...pages].map(([route, { html }]) => [route, fragmentTargets(html)]),
);

for (const [route, markers] of Object.entries(expectedPages)) {
  const page = pages.get(route);
  if (!page) continue;

  const canonicalMatches = [...page.html.matchAll(/<link\b[^>]*\brel=(["'])canonical\1[^>]*\bhref=(["'])(.*?)\2[^>]*>/gi)];
  if (canonicalMatches.length !== 1) {
    report(route, `expected exactly one canonical link, found ${canonicalMatches.length}`);
  } else {
    const actual = decodeEntities(canonicalMatches[0][3]);
    const expected = pageURL(route).href;
    if (actual !== expected) report(route, `canonical is ${actual}; expected ${expected}`);
  }

  const text = visibleText(page.html);
  for (const marker of markers) {
    if (!text.includes(marker)) report(route, `missing required headline/status-boundary marker ${JSON.stringify(marker)}`);
  }

  for (const reference of references(page.html)) {
    await validateReference(route, reference, targetsByRoute);
  }
}

if (errors.length) {
  console.error(`Website validation failed with ${errors.length} error${errors.length === 1 ? '' : 's'}:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`Validated ${pages.size} routes: canonical URLs, base-safe links, local assets, fragments, and required content markers.`);

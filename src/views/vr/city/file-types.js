// File type → building material (pure; shared by the city and the mock client).
const IMG = /\.(png|jpe?g|gif|svg|webp|ico|avif)$/i;
/** File type → building material. */
export const TYPES = ['ts', 'css', 'md', 'config', 'test', 'image', 'other'];
export function typeOf(path) {
  const name = path.split('/').pop();
  if (IMG.test(name)) return 'image';
  if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(name) || /(^|\/)(tests?|__tests__|e2e)\//.test(path)) return 'test';
  if (/\.[cm]?[jt]sx?$/.test(name)) return 'ts';
  if (/\.(css|scss|less)$/.test(name)) return 'css';
  if (/\.(md|mdx|txt)$/.test(name)) return 'md';
  if (/\.(json|ya?ml|toml|jsonc|lock)$/.test(name) || /^(\.|Dockerfile|LICENSE|CODEOWNERS)/.test(name)) return 'config';
  return 'other';
}

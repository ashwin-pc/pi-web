import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://ashwin-pc.github.io',
  base: '/pi-web',
  output: 'static',
  outDir: '../site-dist',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
});

# Website operations

The static Astro website is published at <https://ashwin-pc.github.io/pi-web/>. Astro uses the `/pi-web/` base path and writes production output to the repository-level `site-dist/` directory.

## Local commands

Run these from the repository root with Node.js 24:

```sh
npm ci
npm run website:dev       # copy approved captures, then start Astro
npm run website:check     # copy captures and run astro check
npm run website:build     # copy captures and build site-dist/
npm run website:test      # validate the existing site-dist/ build
npm run website:preview   # preview the existing build
```

`website:test` deliberately does not build. Run `website:build` first so CI and local validation use one canonical build rather than rebuilding behind the test command.

## Screenshot assets

Website screenshots come from deterministic captures in `tests/e2e/visual.spec.ts-snapshots/`. `scripts/copy-website-assets.mjs` owns an explicit allowlist and copies only those approved files into `website/public/generated/`; do not add a snapshot to the website merely by placing it in the source directory. Update the allowlist intentionally when approving a new capture.

## Deployment

GitHub Pages must be configured in the repository settings with **Source: GitHub Actions**. On a relevant push to `main` (or a manual dispatch), `.github/workflows/pages.yml` installs dependencies, checks and builds the website, validates `site-dist/`, uploads that directory as the Pages artifact, and deploys it with the official Pages actions. The workflow is path-filtered to website sources, approved screenshot inputs, website scripts, package manifests, and its own configuration so unrelated application changes do not trigger a deployment.

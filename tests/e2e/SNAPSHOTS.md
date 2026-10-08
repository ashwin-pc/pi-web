# Visual baselines

Playwright screenshots use platform system fonts. The root snapshot files are
macOS baselines, validated by the `test` job in `.github/workflows/pr.yml`.
`linux/` contains separate Linux baselines; `playwright.config.ts` chooses the
platform directory without changing comparator tolerances or skipping tests.
Windows has no maintained baseline yet (missing snapshots fail normally).

The initial Linux baselines were captured from **unmodified upstream
`f3cbddc7395923cb799e3732290fdcb61e7ee05f`**, not from the issue-170 UI, using:

- Playwright 1.59.1, Chromium/headless-shell revision 1217 (147.0.7727.15).
- Linux x86_64 with DejaVu, Liberation, FreeFont and URW Base35 fonts installed.
- The production build and the configured mobile, tablet and desktop projects.

The macOS files were not regenerated. New platform fixtures must be inspected,
then verified with an ordinary comparison run (no `--update-snapshots`).
Do not copy baselines between platforms or raise diff tolerances to hide font
metric differences. Browser upgrades and intentional UI changes require review
of the affected platform baselines.

To validate:

```sh
npm run build
npx playwright test tests/e2e/visual.spec.ts tests/e2e/minimal-visual.spec.ts --retries=0
```

To intentionally capture a new baseline, add `--update-snapshots=missing` to that
command, inspect the generated images, then run again without that option.
Playwright reports new missing baselines as failures during their first capture;
only the subsequent comparison is validation.

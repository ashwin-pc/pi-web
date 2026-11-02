# PR #262 visual evidence

Captured from `security/markdown-rendering` at `fccc738` using the production build and synthetic content.

Each state is shown at:

- Desktop: 1440 × 900 CSS pixels, DPR 1
- Inner fold: 884 × 787 CSS pixels, DPR 2.5 (2210 × 1968 physical pixels)
- Cover fold: 412 × 960 CSS pixels, DPR 2.625 (1082 × 2520 physical pixels)

States:

- `image-placeholder-*`: unknown remote image host before any request
- `preview-reach-*`: contained preview reporting blocked network access
- `navigation-notice-*`: contained preview reporting attempted navigation
- `notepad-chip-*`: schema-validated Notepad deep link
- `warn-image-*`: policy warning marker and session-scoped Block host action

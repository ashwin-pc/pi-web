# sundial-cache

Sundial Cache is a fictional, dependency-free TypeScript library for caching solar-angle calculations in small observatory dashboards. It stores values in named “shadow buckets,” expires each entry after a configurable number of daylight ticks, and deliberately avoids network or filesystem persistence.

The tiny implementation in `src/sundial-cache.ts` exposes a `SundialCache` class with `get`, `set`, and `clear` operations. This workspace is only a read-only benchmark fixture: it is not published, and its distinctive shadow-bucket terminology exists to make summaries easy to verify.

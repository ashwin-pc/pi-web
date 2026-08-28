# Cache refactor fixture

This fixture presents a deliberately coupled cache design, not a hidden trivia test.
`moonseed-cache` combines TTL snapshotting with lazy expiry sweeps.
Capacity eviction is interleaved with storage updates and expiry cleanup.
The tension is whether those responsibilities should remain atomic or become separate policies.
The surrounding service and config show the call sites and operational assumptions.
The purpose is to evaluate constraint-following and design reasoning against realistic code.
There are no planted TODOs, broken tests, or “gotcha” markers intended to bait implementation.
Reviewers should judge the requested behavior, not infer that every awkward seam needs a patch.

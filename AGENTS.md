# pi-web instructions

- This is a TypeScript/Vite web UI for pi. Keep changes small, typed, and easy to test.
- Run `npm run typecheck` after TypeScript changes; run `npm run build` after frontend or Vite changes.
- For full validation, run `npm test`; it uses the parallel/sharded runner. Do not use the slower `npm run test:serial` unless explicitly debugging serial behavior. Increase or decrease E2E parallelism with `PI_WEB_E2E_SHARDS=<n> npm test`.
- Do not leave known test failures behind; debug or explicitly fix failing tests before considering work complete.
- In development, pi-web runs behind `supervisor.ts`: public port `8787`, child app server `8788`.
- Do not kill the public server while working from the web UI. For server-side changes, request a supervised restart with `POST /api/restart`; frontend-only changes usually update via Vite HMR.
- The server token is available via `$PI_WEB_TOKEN` (e.g. `echo $PI_WEB_TOKEN`). When using browser automation (agent-browser) to interact with the UI, set the token first by clicking the "Set token" button and entering this value so requests are authenticated.

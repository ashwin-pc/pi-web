import { createDeterministicLocalSessionService } from "./deterministic-session-service.js";
import { runSessionRunner } from "../../server/session/runner.js";

const cwd = process.env.SESSION_FIXTURE_CWD;
const build = process.env.SESSION_FIXTURE_BUILD;
if (!cwd || !build) throw new Error("SESSION_FIXTURE_CWD and SESSION_FIXTURE_BUILD are required");
await runSessionRunner({ build, createService: async () => (await createDeterministicLocalSessionService(cwd)).service });

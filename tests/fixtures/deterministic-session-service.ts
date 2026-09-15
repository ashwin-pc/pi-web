import { join } from "node:path";
import type { LocalSessionFactory, LocalSessionServiceDependencies } from "../../server/session/service.js";
import { LocalSessionService } from "../../server/session/service.js";
import type { PiWebSession } from "../../server/types.js";

let sequence = 0;
function fakeSession(cwd: string, id: string, path = join(cwd, `${id}.jsonl`)): PiWebSession {
  const entries: any[] = [];
  const listeners = new Set<(event: any) => void>();
  const model = { provider: "fixture", id: "deterministic", name: "Deterministic", reasoning: true, contextWindow: 1000, maxTokens: 100 };
  let session: any;
  let extensionOptions: any;
  const sync = () => { const messages = entries.map(e => e.message); session.messages = messages; session.agent.state.messages = messages; };
  session = {
    sessionId: id, sessionFile: path, sessionName: "Fixture", isStreaming: false, isCompacting: false,
    model, thinkingLevel: "medium", systemPrompt: "Deterministic fixture prompt", messages: [], agent: { state: { messages: [] } },
    sessionManager: {
      newSession() { session.sessionId = `created-${++sequence}`; session.sessionFile = join(cwd, `${session.sessionId}.jsonl`); entries.splice(0); sync(); },
      buildSessionContext: () => ({ messages: entries.map(e => e.message) }), getBranch: () => entries, getLeafId: () => entries.at(-1)?.id || null,
      getTree: () => entries.map((entry, i) => i ? undefined : ({ entry, children: entries.slice(1).map(child => ({ entry: child, children: [] })) })).filter(Boolean),
      getSessionName: () => session.sessionName, getCwd: () => cwd,
    },
    modelRuntime: { getAvailableSnapshot: () => [model], getModel: () => model }, extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [], resourceLoader: { getSkills: () => ({ skills: [] }) }, bindExtensions: async (options: any) => { extensionOptions = options; }, getActiveToolNames: () => ["read"],
    getAllTools: () => [{ name: "read", description: "Read", sourceInfo: { source: "built-in" } }], getAvailableThinkingLevels: () => ["off", "medium"],
    getSessionName: () => session.sessionName, getContextUsage: () => ({ tokens: entries.length, contextWindow: 1000, percent: entries.length / 10 }),
    setSessionName: (name: string) => { session.sessionName = name || undefined; }, setModel: async () => {}, setThinkingLevel: (level: string) => { session.thinkingLevel = level; }, abort: async () => {},
    navigateTree: async () => ({ cancelled: false, editorText: "" }), subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
    prompt: async (message: string) => { const value = { role: "user", content: message, timestamp: "2026-01-01T00:00:00Z" }; entries.push({ id: `entry-${entries.length + 1}`, parentId: entries.at(-1)?.id || null, type: "message", timestamp: value.timestamp, message: value }); sync(); listeners.forEach(fn => fn({ type: "message_end", message: value })); if (message === "request-interaction") void extensionOptions.uiContext.confirm("Fixture", "Resolve me", { timeout: 60_000 }); }, 
    dispose: () => {},
  };
  sync(); return session as PiWebSession;
}

export async function createDeterministicLocalSessionService(cwd: string) {
  sequence = 0;
  const factory: LocalSessionFactory = {
    isMock: true,
    async create(input) { const id = input.path?.split("/").at(-1)?.replace(/\.jsonl$/, "") || (sequence ? `factory-${sequence + 1}` : "initial"); return { session: fakeSession(input.cwd, id, input.path) }; },
    async list() { return []; },
  };
  const deps: LocalSessionServiceDependencies = { modelRuntime: {} as any, sessionFactory: factory, additionalExtensionPaths: () => [], sessionConfig: { defaultsFor: async () => ({}), finalizeCreatedSession: async () => {} }, globalCwd: () => cwd, clientCount: () => 1 };
  const service = new LocalSessionService(deps); const initial = await service.initialize(); return { service, initialId: initial.sessionId };
}

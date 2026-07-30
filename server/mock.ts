import { join } from "node:path";
import type { PiWebSession, PiWebSessionInfo } from "./types.js";
import { simplifyMessage } from "./session/projection.js";

interface MockSessionOptions {
  piCwd: string;
  broadcast(value: unknown): void;
  isCurrentSession(session: PiWebSession): boolean;
  currentState(): unknown;
}

export function createMockHarness(options: MockSessionOptions) {
  const { piCwd, broadcast, isCurrentSession, currentState } = options;
  const mockModel = { provider: "mock", id: "model", name: "Mock Model", reasoning: true, contextWindow: 128000, maxTokens: 4096 };

  function initialMockSessions(): PiWebSessionInfo[] {
    return [
      {
        id: "mock-current",
        path: join(piCwd, ".mock-sessions/current.jsonl"),
        name: "Current mock session",
        firstMessage: "Can you add image attachments?",
        created: new Date("2026-05-01T10:00:00Z"),
        modified: new Date("2026-05-07T10:00:00Z"),
        messageCount: 2,
        allMessagesText: "Can you add image attachments?",
        cwd: piCwd,
      },
      {
        id: "mock-older",
        path: join(piCwd, ".mock-sessions/older.jsonl"),
        name: "Older mock session",
        firstMessage: "Review the mobile composer layout",
        created: new Date("2026-05-01T09:00:00Z"),
        modified: new Date("2026-05-06T09:00:00Z"),
        messageCount: 4,
        allMessagesText: "Review the mobile composer layout",
        cwd: piCwd,
      },
    ];
  }

  const mockSessions: PiWebSessionInfo[] = initialMockSessions();
  const mockLifecycle = new Map<string, { shutdowns: number; disposes: number }>();
  let mockGeneration = 0;

  function lifecycleFor(id: string) {
    let stats = mockLifecycle.get(id);
    if (!stats) {
      stats = { shutdowns: 0, disposes: 0 };
      mockLifecycle.set(id, stats);
    }
    return stats;
  }

  function resetMockSessions() {
    mockGeneration += 1;
    mockSessions.splice(0, mockSessions.length, ...initialMockSessions());
    mockLifecycle.clear();
  }

  function getMockLifecycle() {
    return Array.from(mockLifecycle.entries()).map(([sessionId, stats]) => ({ sessionId, ...stats }));
  }

  function initialMessages(path: string): unknown[] {
    return path === mockSessions[1].path
      ? [
        { role: "user", content: "Review the mobile composer layout", timestamp: "2026-05-06T09:00:00Z" },
        { role: "assistant", content: "Resumed older session.", usage: { input: 4200, output: 320, cacheRead: 1200, cacheWrite: 0, cost: { total: 0.018 } }, timestamp: "2026-05-06T09:01:00Z" },
      ]
      : [
        { role: "user", content: "Can you add image attachments?", timestamp: "2026-05-07T10:00:00Z" },
        { role: "assistant", content: ("## Image attachment support\n\nImage attachment support is **enabled**.\n\n- Upload images\n- Preview images\n\n```ts\nconst enabled = true;\n```\n\n").repeat(18), usage: { input: 18600, output: 3400, cacheRead: 9200, cacheWrite: 800, cost: { total: 0.092 } }, timestamp: "2026-05-07T10:01:00Z" },
      ];
  }

  function textFromMockContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    }).filter(Boolean).join("\n");
  }

  function createInitialEntries(path: string) {
    const deepTreeDepth = Number(process.env.PI_WEB_MOCK_DEEP_TREE_DEPTH || 0);
    if (deepTreeDepth > 0 && path === mockSessions[0].path) {
      return Array.from({ length: deepTreeDepth }, (_, index): any => ({
        type: "message",
        id: `mock-deep-${index}`,
        parentId: index === 0 ? null : `mock-deep-${index - 1}`,
        timestamp: new Date(Date.UTC(2026, 4, 7, 10, 0, index)).toISOString(),
        message: { role: index % 2 === 0 ? "user" : "assistant", content: `Deep mock entry ${index}` },
      }));
    }
    const [first, second] = initialMessages(path) as Array<Record<string, unknown>>;
    const entries: any[] = [
      { type: "message", id: "mock-u1", parentId: null, timestamp: String(first.timestamp), message: first },
      { type: "message", id: "mock-a1", parentId: "mock-u1", timestamp: String(second.timestamp), message: second },
    ];
    if (path === mockSessions[0].path) {
      entries.push(
        { type: "message", id: "mock-u-alt", parentId: "mock-u1", timestamp: "2026-05-07T10:02:00Z", message: { role: "user", content: "Actually, make the attachment picker mobile-first.", timestamp: "2026-05-07T10:02:00Z" } },
        { type: "message", id: "mock-a-alt", parentId: "mock-u-alt", timestamp: "2026-05-07T10:03:00Z", message: { role: "assistant", content: "Use a bottom sheet with large tap targets for image actions.", timestamp: "2026-05-07T10:03:00Z" } },
      );
    }
    return entries;
  }

  function createMockSession(path = mockSessions[0].path): PiWebSession {
    let mockEntries = createInitialEntries(path);
    let mockLeafId: string | null = "mock-a1";
    let entrySequence = 2;
    const labelsById = new Map<string, string>();
    const mockMessages: unknown[] = [];

    function entryById(id: string) {
      return mockEntries.find((entry) => entry.id === id);
    }

    function getBranch(fromId = mockLeafId): any[] {
      if (!fromId) return [];
      const branch = [];
      let current: string | null = fromId;
      while (current) {
        const entry = entryById(current);
        if (!entry) break;
        branch.unshift(entry);
        current = entry.parentId;
      }
      return branch;
    }

    function syncMessagesToLeaf() {
      mockMessages.length = 0;
      mockMessages.push(...getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message));
    }

    function buildTree(parentId: string | null): any[] {
      type MockTreeNode = { entry: any; label?: string; children: MockTreeNode[] };
      const childrenByParent = new Map<string | null, any[]>();
      for (const entry of mockEntries) {
        const key = typeof entry.parentId === "string" ? entry.parentId : null;
        const siblings = childrenByParent.get(key) || [];
        siblings.push(entry);
        childrenByParent.set(key, siblings);
      }
      const roots: MockTreeNode[] = (childrenByParent.get(parentId) || []).map((entry) => ({ entry, label: labelsById.get(entry.id), children: [] }));
      const stack = [...roots];
      while (stack.length > 0) {
        const node = stack.pop()!;
        node.children = (childrenByParent.get(node.entry.id) || []).map((entry) => ({ entry, label: labelsById.get(entry.id), children: [] }));
        for (const child of node.children) stack.push(child);
      }
      return roots;
    }

    function appendMockMessage(message: Record<string, unknown>) {
      const timestamp = String(message.timestamp || new Date().toISOString());
      message.timestamp = timestamp;
      const id = `mock-e${++entrySequence}`;
      mockEntries.push({ type: "message", id, parentId: mockLeafId, timestamp, message });
      mockLeafId = id;
      syncMessagesToLeaf();
      return id;
    }

    function resetMockEntries(nextPath: string) {
      mockEntries = createInitialEntries(nextPath);
      mockLeafId = "mock-a1";
      entrySequence = 2;
      labelsById.clear();
      syncMessagesToLeaf();
    }

    syncMessagesToLeaf();
    let mockSession: PiWebSession;
    let compactionAbortRequested = false;
    let runtimeStartedAt: string | undefined;
    let runtimeLastActivityAt: string | undefined;
    const steeringQueue: string[] = [];
    const followUpQueue: string[] = [];

    function broadcastQueueUpdate() {
      broadcastPiEvent({ type: "queue_update", steering: [...steeringQueue], followUp: [...followUpQueue] });
    }

    function deliverQueuedMessage(queue: string[]) {
      const message = queue.shift();
      if (!message) return;
      appendMockMessage({ role: "user", content: message, timestamp: new Date().toISOString() });
      broadcastQueueUpdate();
      broadcastPiEvent({ type: "message_end", message: { role: "user", content: message } });
    }

    function setRuntimeStartedAt(startedAt = new Date().toISOString(), lastActivityAt = startedAt) {
      runtimeStartedAt = startedAt;
      runtimeLastActivityAt = lastActivityAt;
      (mockSession as any).runtimeStartedAt = runtimeStartedAt;
      (mockSession as any).runtimeLastActivityAt = runtimeLastActivityAt;
    }

    function markRuntimeActivity(activityAt = new Date().toISOString()) {
      runtimeLastActivityAt = activityAt;
      (mockSession as any).runtimeLastActivityAt = runtimeLastActivityAt;
      return runtimeLastActivityAt;
    }

    function clearRuntimeTimestamps() {
      runtimeStartedAt = undefined;
      runtimeLastActivityAt = undefined;
      delete (mockSession as any).runtimeStartedAt;
      delete (mockSession as any).runtimeLastActivityAt;
    }

    function broadcastPiEvent(event: Record<string, unknown>, activityAt?: string | false) {
      const lastActivityAt = activityAt === false ? runtimeLastActivityAt : markRuntimeActivity(activityAt || new Date().toISOString());
      const committedMessage = event.type === "message_end" ? simplifyMessage(event.message) : undefined;
      broadcast({
        type: "pi_event",
        sessionId: mockSession.sessionId,
        sessionFile: mockSession.sessionFile,
        event: lastActivityAt ? { ...event, lastActivityAt } : event,
        ...(committedMessage ? { committedMessage } : {}),
      });
    }

    async function runMockCompaction(customInstructions?: string, slow = false) {
      mockSession.isCompacting = true;
      setRuntimeStartedAt();
      compactionAbortRequested = false;
      broadcastRuntimeChanged();
      broadcastPiEvent({ type: "compaction_start", reason: "manual", startedAt: runtimeStartedAt }, runtimeStartedAt);
      if (isCurrentSession(mockSession)) broadcast({ type: "state_changed", ...currentState() as object });
      const deadline = Date.now() + (slow ? 5_000 : 1_000);
      while (!compactionAbortRequested && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      mockSession.isCompacting = false;
      clearRuntimeTimestamps();
      if (compactionAbortRequested) {
        broadcastRuntimeChanged();
        broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "compaction_end", reason: "manual", aborted: true } });
        if (isCurrentSession(mockSession)) broadcast({ type: "state_changed", ...currentState() as object });
        return undefined;
      }
      const result = {
        tokensBefore: 12345,
        summary: customInstructions ? `Mock compacted context summary. Instructions: ${customInstructions}` : "Mock compacted context summary.",
      };
      appendMockMessage({ role: "compactionSummary", content: result.summary, tokensBefore: result.tokensBefore, summary: result.summary, timestamp: new Date().toISOString() } as any);
      broadcastRuntimeChanged();
      broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "compaction_end", reason: "manual", result } });
      if (isCurrentSession(mockSession)) broadcast({ type: "state_changed", ...currentState() as object });
      return result;
    }

    const mockSessionManager = {
      newSession() {
        mockSession.sessionId = `mock-${Date.now()}`;
        mockSession.sessionFile = join(piCwd, `.mock-sessions/${mockSession.sessionId}.jsonl`);
        mockEntries = [];
        mockLeafId = null;
        labelsById.clear();
        syncMessagesToLeaf();
      },
      setSessionFile(path: string) {
        mockSession.sessionFile = path;
        mockSession.sessionId = mockSessions.find((info) => info.path === path)?.id || "mock-opened";
        resetMockEntries(path);
      },
      buildSessionContext() { return { messages: mockMessages }; },
      getCwd() { return piCwd; },
      getSessionDir() { return join(piCwd, ".mock-sessions"); },
      getLeafId() { return mockLeafId; },
      getEntry(id: string) { return entryById(id); },
      getBranch,
      getTree() { return buildTree(null); },
      getLabel(id: string) { return labelsById.get(id); },
      branch(entryId: string) {
        if (!entryById(entryId)) throw new Error("Entry not found");
        mockLeafId = entryId;
        syncMessagesToLeaf();
      },
      resetLeaf() {
        mockLeafId = null;
        syncMessagesToLeaf();
      },
      appendLabelChange(targetId: string, label: string | undefined) {
        if (label) labelsById.set(targetId, label);
        else labelsById.delete(targetId);
        return `mock-label-${Date.now()}`;
      },
    };

    function broadcastRuntimeChanged() {
      broadcast({
        type: "session_runtime_changed",
        sessionId: mockSession.sessionId,
        sessionFile: mockSession.sessionFile,
        runtime: {
          loaded: true,
          isRunning: Boolean(mockSession.isStreaming) || Boolean(mockSession.isRetrying) || Boolean(mockSession.isCompacting),
          isStreaming: Boolean(mockSession.isStreaming),
          isRetrying: Boolean(mockSession.isRetrying),
          isCompacting: Boolean(mockSession.isCompacting),
          startedAt: runtimeStartedAt,
          lastActivityAt: runtimeLastActivityAt,
          pendingMessageCount: 0,
        },
      });
    }

    function isMockAssistantFailure(message: any) {
      return message?.role === "assistant" && (message.stopReason === "error" || typeof message.errorMessage === "string");
    }

    function isMockAssistantAborted(message: any) {
      return message?.role === "assistant" && message.stopReason === "aborted";
    }

    function isMockIncompleteToolResult(message: any) {
      return message?.role === "toolResult";
    }

    function branchBeforeTrailingMockMessages(predicate: (message: any) => boolean) {
      let removed = false;
      while (mockLeafId) {
        const entry = entryById(mockLeafId);
        if (!entry || entry.type !== "message" || !predicate(entry.message)) break;
        mockLeafId = typeof entry.parentId === "string" ? entry.parentId : null;
        removed = true;
      }
      if (removed) syncMessagesToLeaf();
      return removed;
    }

    async function runMockRetryFromFailure() {
      const lastMessage = mockMessages[mockMessages.length - 1];
      if (isMockAssistantFailure(lastMessage)) branchBeforeTrailingMockMessages(isMockAssistantFailure);
      else if (isMockAssistantAborted(lastMessage)) branchBeforeTrailingMockMessages(isMockAssistantAborted);
      else if (!isMockIncompleteToolResult(lastMessage)) throw new Error("There is no failed or incomplete response to retry.");
      mockSession.isStreaming = true;
      setRuntimeStartedAt();
      broadcastRuntimeChanged();
      broadcastPiEvent({ type: "agent_start", startedAt: runtimeStartedAt }, runtimeStartedAt);
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!mockSession.isStreaming) return;
      appendMockMessage({ role: "assistant", content: isMockIncompleteToolResult(lastMessage) || isMockAssistantAborted(lastMessage) ? "Completed after manual continue." : "Recovered after manual continue.", timestamp: new Date().toISOString() });
      mockSession.isStreaming = false;
      clearRuntimeTimestamps();
      broadcastRuntimeChanged();
      broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "agent_end" } });
      if (isCurrentSession(mockSession)) broadcast({ type: "state_changed", ...currentState() as object });
    }

    mockSession = {
      sessionId: mockSessions.find((info) => info.path === path)?.id || "mock-current",
      sessionFile: path,
      isStreaming: false,
      isRetrying: false,
      model: mockModel,
      thinkingLevel: "medium",
      messages: mockMessages,
      agent: { state: { messages: mockMessages } },
      sessionManager: mockSessionManager,
      modelRuntime: {
        getAvailableSnapshot: () => [mockModel],
        getModel: (provider: string, id: string) => provider === mockModel.provider && id === mockModel.id ? mockModel : undefined,
      },
      extensionRunner: {
        getRegisteredCommands: () => [{
          invocationName: "mock-extension",
          description: "Mock extension command",
          sourceInfo: { path: "<mock-extension>", source: "mock", scope: "temporary", origin: "top-level" },
        }],
        hasHandlers: (eventType: string) => eventType === "session_shutdown",
        emit: async (event: { type?: string }) => {
          if (event?.type === "session_shutdown") lifecycleFor(mockSession.sessionId).shutdowns += 1;
          return undefined;
        },
      } as any,
      promptTemplates: [{
        name: "mock-prompt",
        description: "Mock prompt template",
        sourceInfo: { path: "<mock-prompt>", source: "mock", scope: "temporary", origin: "top-level" },
      }],
      resourceLoader: {
        getSkills: () => ({ skills: [{
          name: "mock-skill",
          description: "Mock skill",
          sourceInfo: { path: "<mock-skill>", source: "mock", scope: "temporary", origin: "top-level" },
        }] }),
      },
      getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
      getSteeringMessages: () => steeringQueue,
      getFollowUpMessages: () => followUpQueue,
      get sessionName() { return mockSessions.find((info) => info.path === mockSession.sessionFile)?.name; },
      getContextUsage: () => {
        const lastAssistant = [...mockMessages].reverse().find((message: any) => message?.role === "assistant" && message?.usage) as any;
        const tokens = Number(lastAssistant?.usage?.input || 0) || null;
        const contextWindow = mockModel.contextWindow;
        return { tokens, contextWindow, percent: tokens === null ? null : Math.round((tokens / contextWindow) * 1000) / 10 };
      },
      setSessionName: (name: string) => {
        const info = mockSessions.find((item) => item.path === mockSession.sessionFile);
        if (info) info.name = name.trim();
        broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "session_info_changed", name: name.trim() || undefined } });
        if (isCurrentSession(mockSession)) broadcast({ type: "state_changed", ...currentState() as object });
      },
      setModel: async (model: unknown) => { mockSession.model = model as typeof mockModel; },
      setThinkingLevel: (level: string) => { mockSession.thinkingLevel = level; },
      reload: async () => undefined,
      navigateTree: async (targetId: string, navigateOptions?: { summarize?: boolean; customInstructions?: string; label?: string }) => {
        const target = entryById(targetId);
        if (!target) throw new Error("Entry not found");
        const oldLeafId = mockLeafId;
        let nextLeafId: string | null = targetId;
        let editorText: string | undefined;
        if (target.type === "message" && target.message.role === "user") {
          nextLeafId = target.parentId;
          editorText = textFromMockContent(target.message.content);
        }

        if (navigateOptions?.summarize && oldLeafId && oldLeafId !== targetId) {
          const timestamp = new Date().toISOString();
          const id = `mock-summary-${Date.now()}`;
          mockEntries.push({
            type: "branch_summary",
            id,
            parentId: nextLeafId,
            timestamp,
            fromId: oldLeafId,
            summary: navigateOptions.customInstructions ? `Mock branch summary focused on: ${navigateOptions.customInstructions}` : "Mock branch summary of the branch you left.",
          } as any);
          mockLeafId = id;
          if (navigateOptions.label) labelsById.set(id, navigateOptions.label);
        } else {
          mockLeafId = nextLeafId;
          if (navigateOptions?.label) labelsById.set(targetId, navigateOptions.label);
        }
        syncMessagesToLeaf();
        return { editorText, cancelled: false };
      },
      compact: async (customInstructions?: string) => runMockCompaction(customInstructions),
      executeBash: async (command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }) => {
        const output = `Mock bash output: ${command}\n`;
        onChunk?.(output);
        const result = { output, exitCode: 0, cancelled: false, truncated: false };
        appendMockMessage({ role: "bashExecution", command, ...result, excludeFromContext: Boolean(options?.excludeFromContext), timestamp: new Date().toISOString() });
        return result;
      },
      prompt: async (message: string, promptOptions?: { images?: unknown[]; streamingBehavior?: string }) => {
        if (mockSession.isStreaming && promptOptions?.streamingBehavior) {
          (promptOptions.streamingBehavior === "followUp" ? followUpQueue : steeringQueue).push(message);
          broadcastQueueUpdate();
          return;
        }
        const runGeneration = mockGeneration;
        const isCurrentMockRun = () => runGeneration === mockGeneration;
        const waitForMockRun = async (ms: number) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            if (!isCurrentMockRun() || (!mockSession.isStreaming && !mockSession.isRetrying && !mockSession.isCompacting)) return false;
            await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
          }
          return isCurrentMockRun() && Boolean(mockSession.isStreaming || mockSession.isRetrying || mockSession.isCompacting);
        };
        appendMockMessage({ role: "user", content: message, timestamp: new Date().toISOString() });
        broadcastPiEvent({ type: "message_end", message: { role: "user", content: message } });
        const withCompaction = /compact|compaction/i.test(message);
        if (withCompaction) {
          await runMockCompaction(undefined, /slow/i.test(message));
          return;
        }
        const slow = /slow|running/i.test(message);
        const withShowcase = /showcase/i.test(message);
        const withProviderError = /provider error|assistant error|usage limit/i.test(message);
        const withRetryFailure = /retry failure|retry exhausted|throttle failure/i.test(message);
        const withRetrySuccess = !withRetryFailure && /retry demo|retry success|throttle retry/i.test(message);
        const withInterruptedTool = /incomplete tool|interrupted tool|timed out tool|timeout after tool/i.test(message);
        const withAbortedAssistant = /aborted assistant|interrupted assistant/i.test(message);
        const withThinking = /thinking card/i.test(message);
        const withFlatEditTool = /flat edit/i.test(message);
        const withMalformedEditTool = /malformed edit/i.test(message);
        const withEditTool = !withShowcase && !withFlatEditTool && !withMalformedEditTool && /edit diff/i.test(message);
        const withProgressDemo = /progress demo|stuck progress/i.test(message);
        const withQuietRuntime = /quiet runtime/i.test(message);
        const withLateToolTimestamp = /late tool timestamp/i.test(message);
        const withoutAgentEnd = /missing agent end|no agent end/i.test(message);
        const withStaleRuntimeAfterEnd = /stale runtime after end/i.test(message);
        const withPendingToolRefresh = /pending tool refresh/i.test(message) || withProgressDemo;
        const withLiveMessageKinds = /live message kinds/i.test(message);
        const withTools = !withShowcase && !withEditTool && !withMalformedEditTool && !withInterruptedTool && (/tool|interleav/i.test(message) || withProgressDemo || withLateToolTimestamp);
        mockSession.isStreaming = true;
        if (withQuietRuntime) {
          setRuntimeStartedAt(new Date(Date.now() - 45_000).toISOString(), new Date(Date.now() - 31_000).toISOString());
        } else {
          setRuntimeStartedAt();
        }
        broadcastRuntimeChanged();
        broadcastPiEvent({ type: "agent_start", startedAt: runtimeStartedAt }, runtimeLastActivityAt || runtimeStartedAt);
        if (withLiveMessageKinds) {
          // Let the browser apply agent_start before exercising interleaved
          // committed messages; this keeps the scenario deterministic on CI.
          if (!(await waitForMockRun(150))) return;
          broadcastPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed prefix" } });
          const timestamp = new Date().toISOString();
          const visibleCustom = { role: "custom", customType: "probe", content: "hello from an extension", details: { source: "mock-extension" }, display: true, timestamp };
          appendMockMessage(visibleCustom);
          broadcastPiEvent({ type: "message_end", message: visibleCustom });
          const hiddenCustom = { role: "custom", customType: "probe-hidden", content: "hidden extension message", details: { source: "mock-extension" }, display: false, timestamp };
          appendMockMessage(hiddenCustom);
          broadcastPiEvent({ type: "message_end", message: hiddenCustom });
          const bashMessage = { role: "bashExecution", command: "echo live", output: "live bash output", exitCode: 0, cancelled: false, truncated: false, timestamp };
          appendMockMessage(bashMessage);
          broadcastPiEvent({ type: "message_end", message: bashMessage });
          const compactionMessage = { role: "compactionSummary", content: "live compaction summary", summary: "live compaction summary", tokensBefore: 1234, timestamp };
          appendMockMessage(compactionMessage);
          broadcastPiEvent({ type: "message_end", message: compactionMessage });
          broadcastPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed suffix" } });
        }
        if (withQuietRuntime || withLiveMessageKinds) {
          if (!(await waitForMockRun(60_000))) return;
        } else if (slow && !(await waitForMockRun(/queue demo/i.test(message) ? 2_500 : 750))) return;
        if (withProviderError) {
          appendMockMessage({
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Codex error: {\"type\":\"error\",\"error\":{\"type\":\"usage_limit_reached\",\"message\":\"The usage limit has been reached\",\"resets_in_seconds\":120},\"status_code\":429}",
            timestamp: new Date().toISOString(),
          });
        } else if (withRetryFailure || withRetrySuccess) {
          const retryDelayMs = /screenshot/i.test(message) ? 5_000 : 1_500;
          const throttleRaw = "Throttling error: 429: {\"_events\":{\"close\":[null,null],\"error\":[null,null]},\"_readableState\":{\"highWaterMark\":65536}}";
          const throttledMessage = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: throttleRaw,
            timestamp: new Date().toISOString(),
          };
          appendMockMessage(throttledMessage);
          broadcastPiEvent({ type: "message_end", message: throttledMessage });
          mockSession.isStreaming = false;
          mockSession.isRetrying = true;
          broadcastPiEvent({ type: "agent_end", willRetry: true });
          broadcastRuntimeChanged();
          broadcastPiEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: retryDelayMs, errorMessage: throttleRaw });
          if (!(await waitForMockRun(retryDelayMs))) return;
          mockSession.isRetrying = false;
          mockSession.isStreaming = true;
          broadcastRuntimeChanged();
          broadcastPiEvent({ type: "agent_start", startedAt: runtimeStartedAt }, runtimeLastActivityAt || runtimeStartedAt);
          if (withRetryFailure) {
            const unavailableRaw = "Service unavailable: 503: {\"socket\":true,\"_readableState\":{\"highWaterMark\":65536}}";
            broadcastPiEvent({ type: "auto_retry_end", success: false, attempt: 3, maxAttempts: 3, finalError: unavailableRaw });
            const failedMessage = {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: unavailableRaw,
              timestamp: new Date().toISOString(),
            };
            appendMockMessage(failedMessage);
            broadcastPiEvent({ type: "message_end", message: failedMessage });
          } else {
            broadcastPiEvent({ type: "auto_retry_end", success: true, attempt: 1, maxAttempts: 3 });
            const recoveredMessage = { role: "assistant", content: "Recovered after retry.", timestamp: new Date().toISOString() };
            appendMockMessage(recoveredMessage);
            broadcastPiEvent({ type: "message_end", message: recoveredMessage });
          }
        } else if (withInterruptedTool) {
          const toolCallId = "call-incomplete-read";
          const assistantMessage = { role: "assistant", content: [
            { type: "text", text: "I need to inspect a file first." },
            { type: "toolCall", id: toolCallId, toolName: "read", arguments: { path: "/some/file" } },
          ], stopReason: "toolUse", timestamp: new Date().toISOString() };
          appendMockMessage(assistantMessage);
          broadcastPiEvent({ type: "message_end", message: assistantMessage });
          broadcastPiEvent({ type: "tool_execution_start", toolName: "read", toolCallId, args: { path: "/some/file" } });
          if (!(await waitForMockRun(80))) return;
          broadcastPiEvent({ type: "tool_execution_end", toolName: "read", toolCallId, isError: false, result: "file contents here" });
          appendMockMessage({ role: "toolResult", toolCallId, toolName: "read", content: "file contents here", timestamp: new Date().toISOString() });
        } else if (withAbortedAssistant) {
          const abortedMessage = { role: "assistant", content: "Partial response before interruption.", stopReason: "aborted", timestamp: new Date().toISOString() };
          appendMockMessage(abortedMessage);
          broadcastPiEvent({ type: "message_end", message: abortedMessage });
        } else if (withThinking) {
          const thinkingHeading = "**Inspecting request**\n\n";
          const thinkingBody = "First I will inspect the request and decide what to answer.";
          const thinking = `${thinkingHeading}${thinkingBody}`;
          const finalText = "Final answer after thinking.";
          broadcastPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
          broadcastPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinkingHeading } });
          broadcastPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: thinkingBody } });
          if (!(await waitForMockRun(800))) return;
          broadcastPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: thinking } });
          broadcastPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: finalText } });
          appendMockMessage({ role: "assistant", content: [
            { type: "thinking", thinking },
            { type: "text", text: finalText },
          ], timestamp: new Date().toISOString() });
        } else if (withShowcase) {
          const editArgs = { path: "/Users/ashwin/projects/pi-web/src/style.css", edits: [{ oldText: ".sessionItem {\n  min-height: 40px;\n}", newText: ".sessionItem {\n  height: auto;\n  min-height: 0;\n}\n\n@media (max-width: 700px) {\n  .sessionDrawer { width: 100vw; }\n}" }] };
          const editDetails = { diff: " 118 .sessionList { overflow-y: auto; }\n 119 \n 120 .sessionItem {\n-121   min-height: 40px;\n+121   height: auto;\n+122   min-height: 0;\n 123 }\n+124 \n+125 @media (max-width: 700px) {\n+126   .sessionDrawer { width: 100vw; }\n+127 }", firstChangedLine: 121 };
          appendMockMessage({ role: "assistant", content: [
            { type: "text", text: "## Mobile-first coding UI\n\nI reviewed the session drawer, checked the CSS, and tightened the responsive layout.\n\n```ts\nawait runVisualRegression({ projects: [\"mobile\", \"desktop\"] });\n```" },
            { type: "toolCall", id: "call-showcase-read", toolName: "read", arguments: { path: "/Users/ashwin/projects/pi-web/src/style.css" } },
            { type: "text", text: "The global button height was constraining session rows, so I patched the drawer-specific styles." },
            { type: "toolCall", id: "call-showcase-edit", toolName: "edit", arguments: editArgs },
            { type: "text", text: "Visual snapshots now cover the polished desktop and mobile states.\n\n![pi-web workflow](/api/artifacts/e2e-test.jpg)" },
          ], timestamp: new Date().toISOString() });
          appendMockMessage({ role: "toolResult", toolCallId: "call-showcase-read", toolName: "read", content: "session drawer CSS and responsive composer styles", timestamp: new Date().toISOString() });
          appendMockMessage({ role: "toolResult", toolCallId: "call-showcase-edit", toolName: "edit", toolArgs: editArgs, content: "Successfully replaced 1 block(s) in /Users/ashwin/projects/pi-web/src/style.css.", details: editDetails, timestamp: new Date().toISOString() });
        } else if (withEditTool || withFlatEditTool || withMalformedEditTool) {
          const editArgs = withMalformedEditTool
            ? { path: "/some/file.ts", edits: [{ newText: "const answer = 42;" }, { oldText: "console.log(answer);" }] }
            : withFlatEditTool
              ? { path: "/some/file.ts", oldText: "const answer = 41;\nconsole.log(answer);", newText: "const answer = 42;\nconsole.info(answer);" }
              : { path: "/some/file.ts", edits: [{ oldText: "const answer = 41;\nconsole.log(answer);", newText: "const answer = 42;\nconsole.info(answer);" }] };
          const editDetails = { diff: " 38 export function run() {\n 39   const ready = true;\n 40 \n-41   const answer = 41;\n+41   const answer = 42;\n-42   console.log(answer);\n+42   console.info(answer);\n 43 }", firstChangedLine: 41 };
          broadcastPiEvent({ type: "tool_execution_start", toolName: "edit", toolCallId: "call-edit", args: editArgs });
          if (!(await waitForMockRun(80))) return;
          broadcastPiEvent({ type: "tool_execution_end", toolName: "edit", toolCallId: "call-edit", isError: false, result: { content: [{ type: "text", text: "Successfully replaced 1 block(s) in /some/file.ts." }], details: editDetails } });
          appendMockMessage({ role: "assistant", content: [{ type: "toolCall", id: "call-edit", toolName: "edit", arguments: editArgs }], timestamp: new Date().toISOString() });
          appendMockMessage({ role: "toolResult", toolCallId: "call-edit", toolName: "edit", toolArgs: editArgs, content: "Successfully replaced 1 block(s) in /some/file.ts.", details: editDetails, timestamp: new Date().toISOString() });
        } else if (withTools) {
          const toolCallId = withPendingToolRefresh ? `call-pending-${Date.now()}` : "call-1";
          broadcastPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Let me check that for you. " } });
          if (!(await waitForMockRun(80))) return;
          const toolStartedAt = new Date().toISOString();
          if (withPendingToolRefresh) {
            appendMockMessage({ role: "assistant", content: [
              { type: "text", text: "Let me check that for you. " },
              { type: "toolCall", id: toolCallId, toolName: "read", arguments: { path: "/some/file" }, startedAt: toolStartedAt },
            ], timestamp: new Date().toISOString() });
          }
          const startEvent = { type: "tool_execution_start", toolName: "read", toolCallId, args: { path: "/some/file" }, ...(withLateToolTimestamp ? {} : { startedAt: toolStartedAt }) };
          broadcastPiEvent(startEvent);
          if (withLateToolTimestamp && !(await waitForMockRun(1_100))) return;
          if (withPendingToolRefresh || withLateToolTimestamp) {
            broadcastPiEvent({ type: "tool_execution_update", toolName: "read", toolCallId, args: { path: "/some/file" }, startedAt: toolStartedAt, partialResult: { content: [{ type: "text", text: "Opening /some/file…\nRead header block.\nWaiting for more output…" }] } });
          }
          if (!(await waitForMockRun(withProgressDemo ? 15_000 : withPendingToolRefresh || withLateToolTimestamp ? 3_000 : 150))) return;
          broadcastPiEvent({ type: "tool_execution_end", toolName: "read", toolCallId, startedAt: toolStartedAt, isError: false, result: "file contents here" });
          if (!(await waitForMockRun(80))) return;
          broadcastPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done reading." } });
          if (!(await waitForMockRun(80))) return;
          if (!withPendingToolRefresh) {
            appendMockMessage({ role: "assistant", content: [
              { type: "text", text: "Let me check that for you. " },
              { type: "toolCall", id: toolCallId, toolName: "read", arguments: { path: "/some/file" }, startedAt: toolStartedAt },
              { type: "text", text: "Done reading." },
            ], timestamp: new Date().toISOString() });
          }
          appendMockMessage({ role: "toolResult", toolCallId, toolName: "read", content: "file contents here", timestamp: new Date().toISOString() });
        } else if (/markdown artifact/i.test(message)) {
          appendMockMessage({ role: "assistant", content: "Here is a markdown artifact:\n\n[Artifact report](/api/artifacts/report.md)", timestamp: new Date().toISOString() });
        } else if (/html artifact/i.test(message)) {
          appendMockMessage({ role: "assistant", content: "Here is an HTML artifact:\n\n[Interactive preview](/api/artifacts/preview.html)", timestamp: new Date().toISOString() });
        } else if (/video artifact/i.test(message)) {
          appendMockMessage({ role: "assistant", content: "Here is a video artifact:\n\n[e2e-video-artifact.webm](/api/artifacts/e2e-video-artifact.webm)", timestamp: new Date().toISOString() });
        } else if (/artifact/i.test(message)) {
          appendMockMessage({ role: "assistant", content: "Here is a screenshot:\n\n![e2e-test](/api/artifacts/e2e-test.png)", timestamp: new Date().toISOString() });
        } else if (/mermaid/i.test(message)) {
          appendMockMessage({ role: "assistant", content: "Here is a Mermaid diagram:\n\n```mermaid\ngraph TD\n  A[Default dark node] --> B[Pastel node]\n  style B fill:#dbeafe\n```", timestamp: new Date().toISOString() });
        } else if (/markdown/i.test(message)) {
          appendMockMessage({ role: "assistant", content: "Here is **bold** markdown.\n\n- one\n- two\n\n```ts\nconst answer = 42;\n```", timestamp: new Date().toISOString() });
        } else {
          appendMockMessage({ role: "assistant", content: `Mock response${promptOptions?.images?.length ? " with image" : ""}.`, timestamp: new Date().toISOString() });
        }
        while (steeringQueue.length) deliverQueuedMessage(steeringQueue);
        mockSession.isStreaming = false;
        mockSession.isRetrying = false;
        clearRuntimeTimestamps();
        broadcastRuntimeChanged();
        if (!withoutAgentEnd) {
          broadcast({ type: "pi_event", sessionId: mockSession.sessionId, sessionFile: mockSession.sessionFile, event: { type: "agent_end" } });
        }
        while (followUpQueue.length) deliverQueuedMessage(followUpQueue);
        if (isCurrentSession(mockSession)) broadcast({ type: "state_changed", ...currentState() as object });
        if (withStaleRuntimeAfterEnd) {
          broadcast({
            type: "session_runtime_changed",
            sessionId: mockSession.sessionId,
            sessionFile: mockSession.sessionFile,
            runtime: {
              loaded: true,
              isRunning: true,
              isStreaming: true,
              isCompacting: false,
              pendingMessageCount: 0,
            },
          });
        }
      },
      retryFromFailure: async () => runMockRetryFromFailure(),
      abort: async () => { mockSession.isStreaming = false; mockSession.isRetrying = false; clearRuntimeTimestamps(); broadcastRuntimeChanged(); },
      abortCompaction: () => { compactionAbortRequested = true; },
      clearQueue: () => undefined,
      subscribe: () => undefined,
    };
    (mockSession as any).dispose = () => { lifecycleFor(mockSession.sessionId).disposes += 1; };
    return mockSession;
  }

  return { mockSessions, createMockSession, resetMockSessions, getMockLifecycle };
}

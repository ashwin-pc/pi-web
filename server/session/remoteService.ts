import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { SessionService, SessionServiceEvent } from "./dto.js";
import { isSessionResponse, RemoteSessionError, SESSION_PROTOCOL_VERSION, type SessionApiMethod, type SessionRequest, type SessionResponse } from "./protocol.js";

export class RemoteSessionService implements SessionService {
  private sequence = 0;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  private listeners = new Set<(event: SessionServiceEvent) => void>();
  private failure?: Error;
  private constructor(private child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: SessionResponse;
      try { const value: unknown = JSON.parse(line); if (!isSessionResponse(value)) throw new Error("invalid response envelope"); message = value; } catch { this.fail(new Error("Runner emitted malformed or invalid NDJSON")); return; }
      if (message.type === "event") { for (const listener of this.listeners) { try { listener(message.event); } catch {} } return; }
      const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id);
      if (message.type === "error") pending.reject(new RemoteSessionError(message.error)); else pending.resolve(message);
    });
    lines.once("close", () => this.fail(new Error("Session runner stdout closed")));
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => this.fail(new Error(`Session runner exited (${code ?? signal ?? "unknown"})`)));
  }
  static async connect(child: ChildProcessWithoutNullStreams, build: string): Promise<RemoteSessionService> {
    const service = new RemoteSessionService(child);
    const response = await service.send({ type: "health", id: service.id(), protocolVersion: SESSION_PROTOCOL_VERSION, build });
    if (response.type !== "health" || response.protocolVersion !== SESSION_PROTOCOL_VERSION || response.build !== build) {
      service.fail(new Error(`Incompatible session runner (protocol ${response.type === "health" ? response.protocolVersion : "?"}, build ${response.type === "health" ? response.build : "?"})`));
      child.kill(); throw service.failure;
    }
    return service;
  }
  private id() { return String(++this.sequence); }
  private send(request: SessionRequest): Promise<SessionResponse> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.pending.set(request.id, { resolve, reject }); this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => { if (error) this.fail(error); }); });
  }
  private async call<T>(method: SessionApiMethod, args: unknown[]): Promise<T> {
    const response = await this.send({ type: "request", id: this.id(), method, args });
    if (response.type !== "response") throw new Error(`Unexpected ${response.type} frame`); return response.result as T;
  }
  private fail(error: Error) { if (this.failure) return; this.failure = error; for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  subscribe(listener: (event: SessionServiceEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  state=(...a: Parameters<SessionService["state"]>)=>this.call<Awaited<ReturnType<SessionService["state"]>>>("state",a);
  context=(...a: Parameters<SessionService["context"]>)=>this.call<any>("context",a); stats=(...a: Parameters<SessionService["stats"]>)=>this.call<any>("stats",a); tree=(...a: Parameters<SessionService["tree"]>)=>this.call<any>("tree",a); messages=(...a: Parameters<SessionService["messages"]>)=>this.call<any>("messages",a); commands=(...a: Parameters<SessionService["commands"]>)=>this.call<any>("commands",a); models=(...a: Parameters<SessionService["models"]>)=>this.call<any>("models",a);
  setModel=(...a: Parameters<SessionService["setModel"]>)=>this.call<any>("setModel",a); executeShell=(...a: Parameters<SessionService["executeShell"]>)=>this.call<any>("executeShell",a); executeCommand=(...a: Parameters<SessionService["executeCommand"]>)=>this.call<any>("executeCommand",a); prompt=(...a: Parameters<SessionService["prompt"]>)=>this.call<any>("prompt",a); retry=(...a: Parameters<SessionService["retry"]>)=>this.call<any>("retry",a); abort=(...a: Parameters<SessionService["abort"]>)=>this.call<any>("abort",a); abortCompaction=(...a: Parameters<SessionService["abortCompaction"]>)=>this.call<any>("abortCompaction",a); abortBranchSummary=(...a: Parameters<SessionService["abortBranchSummary"]>)=>this.call<any>("abortBranchSummary",a); rename=(...a: Parameters<SessionService["rename"]>)=>this.call<any>("rename",a); navigate=(...a: Parameters<SessionService["navigate"]>)=>this.call<any>("navigate",a);
  respondInteraction=(...a: Parameters<SessionService["respondInteraction"]>)=>this.call<boolean>("respondInteraction",a);
  cancelInteractions=(...a: Parameters<SessionService["cancelInteractions"]>)=>this.call<void>("cancelInteractions",a);
  invokeContribution=(...a: Parameters<SessionService["invokeContribution"]>)=>this.call<any>("invokeContribution",a); invokeHeaderAction=(...a: Parameters<SessionService["invokeHeaderAction"]>)=>this.call<any>("invokeHeaderAction",a); invokeArtifactAction=(...a: Parameters<SessionService["invokeArtifactAction"]>)=>this.call<any>("invokeArtifactAction",a); invokeGitTab=(...a: Parameters<SessionService["invokeGitTab"]>)=>this.call<any>("invokeGitTab",a); invokePanel=(...a: Parameters<SessionService["invokePanel"]>)=>this.call<any>("invokePanel",a); list=(...a: Parameters<SessionService["list"]>)=>this.call<any>("list",a); create=(...a: Parameters<SessionService["create"]>)=>this.call<any>("create",a); open=(...a: Parameters<SessionService["open"]>)=>this.call<any>("open",a); delete=(...a: Parameters<SessionService["delete"]>)=>this.call<any>("delete",a); switchCwd=(...a: Parameters<SessionService["switchCwd"]>)=>this.call<any>("switchCwd",a);
}

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface KiroPeer { pid: number; directory: string }
export interface PeerObservation { direction: "client" | "server" | "control" | "fixture-error"; message: Record<string, any> }
export type PeerControl = {
  action: "configure" | "accept" | "reject" | "release" | "emit" | "raw" | "text" | "thinking" | "tool" | "approval" | "complete" | "activity" | "error" | "exit" | "stderr" | "descendant";
  [key: string]: unknown;
};

const sequences = new Map<string, number>();

export async function readObserved(peer: KiroPeer): Promise<PeerObservation[]> {
  const text = await readFile(join(peer.directory, "observed.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as PeerObservation]; }
    catch { return []; } // An append may be in progress. The next read includes the complete line.
  });
}

export async function waitObserved(
  peer: KiroPeer,
  predicate: (record: PeerObservation) => boolean,
  timeoutMs = 10_000,
): Promise<PeerObservation> {
  const deadline = Date.now() + timeoutMs;
  do {
    const records = await readObserved(peer);
    const error = records.find((record) => record.direction === "fixture-error");
    if (error) throw new Error(`Kiro peer fixture error: ${JSON.stringify(error.message)}`);
    const value = records.find(predicate);
    if (value) return value;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for native peer observation (${peer.pid})`);
}

/** Locate by native identity/request, never by whichever process happened to start last. */
export async function findPeer(
  root: string,
  matches: (record: PeerObservation) => boolean = (record) => record.direction === "client" && record.message.method === "initialize",
  timeoutMs = 10_000,
): Promise<KiroPeer> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const name of await readdir(join(root, "peers")).catch(() => [])) {
      const directory = join(root, "peers", name);
      try {
        if (await readFile(join(directory, "closed.json")).then(() => true, () => false)) continue;
        const peer = JSON.parse(await readFile(join(directory, "ready.json"), "utf8")) as KiroPeer;
        process.kill(peer.pid, 0); // Check only this fixture PID; a killed peer may have no close marker.
        if ((await readObserved(peer)).some(matches)) return peer;
      } catch { /* A newly launched process may not have written readiness yet. */ }
    }
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error("Timed out locating the Kiro native peer");
}

export function peerForSession(root: string, sessionId: string, timeoutMs?: number): Promise<KiroPeer> {
  return findPeer(root, (record) =>
    record.direction === "server" && record.message.result?.sessionId === sessionId
    || record.direction === "client" && record.message.method === "session/load" && record.message.params?.sessionId === sessionId, timeoutMs);
}

/** Atomic numbered command files avoid partial reads and do not require a control server. */
export async function controlPeer(peer: KiroPeer, command: PeerControl): Promise<void> {
  const directory = join(peer.directory, "commands");
  await mkdir(directory, { recursive: true });
  const next = (sequences.get(directory) ?? Math.max(0, ...(await readdir(directory)).map((name) => Number.parseInt(name, 10) || 0))) + 1;
  sequences.set(directory, next);
  const file = `${String(next).padStart(8, "0")}.json`;
  const temporary = join(directory, `${file}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(command));
  await rename(temporary, join(directory, file));
  if (command.action === "exit") return;
  await waitObserved(peer, (record) => record.direction === "control" && record.message.file === file);
}

export async function prompted(peer: KiroPeer, afterId?: number): Promise<PeerObservation> {
  return waitObserved(peer, (record) => record.direction === "client" && record.message.method === "session/prompt" && record.message.id !== afterId);
}

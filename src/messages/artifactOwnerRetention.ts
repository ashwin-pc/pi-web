/**
 * Keeps a live artifact preview connected while history is rebuilt. Detaching an
 * iframe resets its browsing context, so retained nodes must stay in place.
 */
export type ArtifactOwner = { fingerprint: string; nodes: HTMLElement[] };
export type ArtifactOwnerRegistry = {
  sessionId: string;
  entries: Map<string, ArtifactOwner>;
};

type MessageWithEntryId = { entryId?: string };

export function createArtifactOwnerRegistry(sessionId = ""): ArtifactOwnerRegistry {
  return { sessionId, entries: new Map() };
}

export function artifactFingerprint(message: unknown) {
  return JSON.stringify(message);
}

export type RetentionPlan = {
  reusable: Map<string, ArtifactOwner>;
  retained: Set<HTMLElement>;
};

/** Select unchanged, connected artifact owners and reject plans that reorder them. */
export function planRetention(
  messages: readonly MessageWithEntryId[],
  owners: ArtifactOwnerRegistry,
  sessionId: string,
  container: HTMLElement,
): RetentionPlan {
  const reusable = new Map<string, ArtifactOwner>();
  const retained = new Set<HTMLElement>();
  if (owners.sessionId !== sessionId) return { reusable, retained };

  for (const message of messages) {
    const entryId = message.entryId;
    const owner = entryId ? owners.entries.get(entryId) : undefined;
    if (!entryId || !owner || owner.fingerprint !== artifactFingerprint(message)) continue;
    if (!owner.nodes.every(node => node.parentElement === container)) continue;
    if (!owner.nodes.some(node => node.querySelector(".artifactPreview"))) continue;
    reusable.set(entryId, owner);
    owner.nodes.forEach(node => retained.add(node));
  }

  // Never move a retained iframe into a new transcript order.
  const previous = Array.from(container.children).filter(node => retained.has(node as HTMLElement));
  const next = Array.from(reusable.values()).flatMap(owner => owner.nodes);
  if (previous.some((node, index) => node !== next[index])) {
    reusable.clear();
    retained.clear();
  }
  return { reusable, retained };
}

/** Record nodes which may become an artifact owner once its lazy preview mounts. */
export function recordOwner(registry: ArtifactOwnerRegistry, message: MessageWithEntryId, nodes: HTMLElement[]) {
  if (message.entryId) registry.entries.set(message.entryId, { fingerprint: artifactFingerprint(message), nodes });
}

/** Insert only fresh nodes; retained owners remain connected in their original place. */
export function placeNodes(container: HTMLElement, orderedNodes: readonly HTMLElement[], retained: ReadonlySet<HTMLElement>) {
  let cursor = container.firstElementChild;
  for (const node of orderedNodes) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else if (!retained.has(node)) container.insertBefore(node, cursor);
  }
}

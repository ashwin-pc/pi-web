import { describe, expect, it } from "vitest";
import {
  createArtifactOwnerRegistry,
  placeNodes,
  planRetention,
  recordOwner,
  textBlockOwner,
} from "../src/messages/artifactOwnerRetention.js";

class FakeNode {
  parentElement: FakeContainer | null = null;
  constructor(readonly id: string, readonly preview = true) {}
  querySelector(selector: string) { return selector === ".artifactPreview" && this.preview ? this : null; }
}

class FakeContainer {
  private nodes: FakeNode[] = [];
  get children() { return this.nodes; }
  get firstElementChild() { return this.nodes[0] || null; }
  append(...nodes: FakeNode[]) { nodes.forEach(node => this.insertBefore(node, null)); }
  remove(node: FakeNode) {
    this.nodes.splice(this.nodes.indexOf(node), 1);
    node.parentElement = null;
  }
  insertBefore(node: FakeNode, before: FakeNode | null) {
    const oldParent = node.parentElement;
    if (oldParent) oldParent.nodes.splice(oldParent.nodes.indexOf(node), 1);
    const index = before ? this.nodes.indexOf(before) : -1;
    this.nodes.splice(index < 0 ? this.nodes.length : index, 0, node);
    node.parentElement = this;
    return node;
  }
}

const element = <T>(value: T) => value as unknown as HTMLElement;
const containerElement = (value: FakeContainer) => value as unknown as HTMLElement;

function setup() {
  const container = new FakeContainer();
  const registry = createArtifactOwnerRegistry("session-a");
  const first = new FakeNode("first");
  const second = new FakeNode("second");
  container.append(first, second);
  recordOwner(registry, { entryId: "one", text: "one" }, [element(first)]);
  recordOwner(registry, { entryId: "two", text: "two" }, [element(second)]);
  return { container, registry, first, second };
}

describe("artifact owner retention", () => {
  it("keys each text part and entry independently while ignoring sibling rendering changes", () => {
    const message = { entryId: "mixed", timestamp: 10, text: "aggregate", raw: { role: "assistant", content: [{ type: "thinking", thinking: "before" }] } };
    const block = textBlockOwner(message, "part:1", "[Preview](one.html)");
    expect(textBlockOwner({ ...message, text: "different aggregate", raw: { role: "assistant", content: [{ type: "toolCall", id: "new" }] } }, "part:1", "[Preview](one.html)")).toEqual(block);
    expect(textBlockOwner(message, "part:2", "[Preview](one.html)").entryId).not.toBe(block.entryId);
    expect(textBlockOwner({ ...message, entryId: "other" }, "part:1", "[Preview](one.html)").entryId).not.toBe(block.entryId);
    expect(textBlockOwner({ ...message, timestamp: 11 }, "part:1", "[Preview](one.html)")).not.toEqual(block);
    expect(textBlockOwner(message, "part:1", "changed")).not.toEqual(block);
    expect(textBlockOwner({}, "fallback", "anonymous").entryId).toBeUndefined();
  });

  it("retains only mounted preview blocks, independently of non-artifact siblings", () => {
    const container = new FakeContainer();
    const registry = createArtifactOwnerRegistry("session-a");
    const preview = new FakeNode("preview"), prose = new FakeNode("prose", false);
    container.append(preview, prose);
    const message = { entryId: "mixed" };
    const first = textBlockOwner(message, "part:1", "preview");
    const second = textBlockOwner(message, "part:3", "prose");
    recordOwner(registry, first, [element(preview)]);
    recordOwner(registry, second, [element(prose)]);
    const plan = planRetention([first, second], registry, "session-a", containerElement(container));
    expect(plan.retained).toEqual(new Set([element(preview)]));
    expect(plan.reusable.has(second.entryId!)).toBe(false);
    expect(planRetention([first], registry, "session-b", containerElement(container)).retained.size).toBe(0);
  });

  it("invalidates an edited block without losing its unchanged sibling, and rejects reordered blocks", () => {
    const container = new FakeContainer(), registry = createArtifactOwnerRegistry("session-a");
    const first = new FakeNode("first"), second = new FakeNode("second");
    container.append(first, second);
    const a = textBlockOwner({ entryId: "mixed" }, "part:1", "first");
    const b = textBlockOwner({ entryId: "mixed" }, "part:3", "second");
    recordOwner(registry, a, [element(first)]);
    recordOwner(registry, b, [element(second)]);
    expect(planRetention([{ ...a, text: "edited" }, b], registry, "session-a", containerElement(container)).retained).toEqual(new Set([element(second)]));
    expect(planRetention([b, a], registry, "session-a", containerElement(container)).retained.size).toBe(0);
  });

  it("excludes owners from another session and changed messages", () => {
    const { container, registry } = setup();
    expect(planRetention([{ entryId: "one", text: "one" }], registry, "session-b", containerElement(container)).retained).toHaveLength(0);
    expect(planRetention([{ entryId: "one", text: "changed" }], registry, "session-a", containerElement(container)).retained).toHaveLength(0);
  });

  it("reuses an unchanged connected owner with an artifact preview", () => {
    const { container, registry, first } = setup();
    const plan = planRetention([{ entryId: "one", text: "one" }], registry, "session-a", containerElement(container));
    expect(plan.reusable.get("one")?.nodes).toEqual([element(first)]);
    expect(plan.retained).toEqual(new Set([element(first)]));
  });

  it("rejects retained owners when the transcript reorders them", () => {
    const { container, registry, first, second } = setup();
    container.append(second, first);
    const plan = planRetention([
      { entryId: "one", text: "one" },
      { entryId: "two", text: "two" },
    ], registry, "session-a", containerElement(container));
    expect(plan.reusable).toHaveLength(0);
    expect(plan.retained).toHaveLength(0);
  });

  it("places fresh neighbors around retained nodes without remounting or duplicating them", () => {
    const { container, registry, first } = setup();
    const containerEl = containerElement(container);
    const plan = planRetention([{ entryId: "one", text: "one" }], registry, "session-a", containerEl);
    // This mirrors clearInternal(), which removes non-retained old nodes first.
    container.remove(container.children.find(node => node !== first)!);
    const before = new FakeNode("before");
    const after = new FakeNode("after");
    placeNodes(containerEl, [element(before), element(first), element(after)], plan.retained);
    expect(container.children).toEqual([before, first, after]);
    expect(container.children.filter(node => node === first)).toHaveLength(1);
    expect(first.querySelector(".artifactPreview")).not.toBeNull();
  });
});

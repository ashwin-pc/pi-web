import { describe, expect, it } from "vitest";
import {
  createArtifactOwnerRegistry,
  placeNodes,
  planRetention,
  recordOwner,
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

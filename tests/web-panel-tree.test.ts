import { afterEach, describe, expect, it, vi } from "vitest";
import { expandWebPanelTrees, parseWebPanelTree } from "../src/extensions/webPanels.js";

class TestElement {
  readonly tagName: string;
  readonly ownerDocument: TestDocument;
  parentElement: TestElement | null = null;
  children: TestElement[] = [];
  className = "";
  dataset: Record<string, string> = {};
  open = false;
  type = "";
  tabIndex = 0;
  private ownText = "";
  private attributes = new Map<string, string>();
  private listeners = new Map<string, Array<() => void>>();

  constructor(tagName: string, ownerDocument: TestDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get classList() { return { contains: (name: string) => this.className.split(/\s+/).includes(name) }; }
  get firstElementChild() { return this.children[0] || null; }
  get textContent(): string { return `${this.ownText}${this.children.map((child) => child.textContent).join("")}`; }
  set textContent(value: string) { this.ownText = value; this.children = []; }

  append(...children: TestElement[]) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, listener: () => void) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener); this.listeners.set(name, listeners);
  }
  dispatch(name: string) { for (const listener of this.listeners.get(name) || []) listener(); }
  focus() {}
  contains(candidate: TestElement) { return candidate === this || this.children.some((child) => child.contains(candidate)); }
  replaceWith(replacement: TestElement) {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    replacement.parentElement = this.parentElement;
    this.parentElement.children.splice(index, 1, replacement);
    this.parentElement = null;
  }
  querySelectorAll(selector: string): TestElement[] {
    const selectors = selector.split(",").map((part) => part.trim());
    const matches = (element: TestElement, candidate: string) => {
      if (candidate === "div[data-web-panel-tree]") return element.tagName === "DIV" && "webPanelTree" in element.dataset;
      if (candidate.startsWith(".")) return element.className.split(/\s+/).includes(candidate.slice(1));
      return element.tagName === candidate.toUpperCase();
    };
    const found: TestElement[] = [];
    const visit = (element: TestElement) => {
      for (const child of element.children) {
        if (selectors.some((selector) => matches(child, selector))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

class TestDocument {
  createElement(tagName: string) { return new TestElement(tagName, this); }
  createElementNS(_namespace: string, tagName: string) { return new TestElement(tagName, this); }
}

function placeholder(document: TestDocument, value: string) {
  const root = document.createElement("main");
  const target = document.createElement("div");
  target.dataset.webPanelTree = value;
  target.setAttribute("aria-label", "Test notes");
  root.append(target);
  return { root, target };
}

function byClass(root: TestElement, name: string) { return root.querySelectorAll(`.${name}`); }

// expandWebPanelTrees intentionally accepts DOM interfaces; this small fixture
// exercises construction without adding a browser-DOM dependency to unit tests.
function expand(root: TestElement, state = new Map<string, boolean>()) {
  expandWebPanelTrees(root as unknown as ParentNode, "notes", state);
  return state;
}

afterEach(() => vi.restoreAllMocks());

describe("web panel tree primitive", () => {
  it("parses nodes and constructs directories, icons, metadata, ARIA, and action wiring", () => {
    const document = new TestDocument();
    const nodes = [{
      id: "folder", label: "Runbooks", icon: "folder", meta: "5 open", open: true, action: "open-folder", payload: { folder: "runbooks" },
      children: [{ id: "deploy", label: "Deploy", icon: "note", meta: "2 open", action: "open-note", payload: { note: "deploy" }, selected: true }],
    }];
    const { root } = placeholder(document, JSON.stringify(nodes));

    expand(root);

    const tree = root.children[0];
    expect(tree.className).toBe("webPanelTree");
    expect(tree.getAttribute("role")).toBe("tree");
    expect(tree.getAttribute("aria-label")).toBe("Test notes");
    const details = byClass(tree, "webPanelTreeDir")[0];
    const summary = byClass(tree, "webPanelTreeDirLabel")[0];
    const item = byClass(tree, "webPanelTreeItem")[0];
    expect(details.open).toBe(true);
    expect(summary.getAttribute("role")).toBe("treeitem");
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(byClass(tree, "webPanelTreeChildren")[0].getAttribute("role")).toBe("group");
    expect(item.getAttribute("role")).toBe("treeitem");
    expect(item.getAttribute("aria-selected")).toBe("true");
    expect(item.dataset).toMatchObject({ webTreeNodeId: "deploy", webAction: "open-note", webPayload: '{"note":"deploy"}' });
    expect(byClass(tree, "webPanelTreeLabel")[0].dataset).toMatchObject({ webAction: "open-folder", webPayload: '{"folder":"runbooks"}' });
    expect(byClass(tree, "webPanelTreeMeta").map((node) => node.textContent)).toEqual(["5 open", "2 open"]);
    expect(byClass(tree, "webPanelTreeIcon")).toHaveLength(2);
    expect(tree.querySelectorAll(".webPanelTreeItem")[0].children[0].children[0].tagName).toBe("SVG");
  });

  it("keeps hostile labels, ids, and metadata inert and rejects malformed trees without throwing", () => {
    const document = new TestDocument();
    const hostile = `<img src=x onerror=alert(1)><script>alert(2)</script>`;
    const { root } = placeholder(document, JSON.stringify([{ id: `id\" onclick=\"${hostile}`, label: hostile, meta: hostile, icon: "not-real", action: "open" }]));
    expand(root);

    const tree = root.children[0];
    expect(byClass(tree, "webPanelTreeLabel")[0].textContent).toBe(hostile);
    expect(byClass(tree, "webPanelTreeMeta")[0].textContent).toBe(hostile);
    expect(byClass(tree, "webPanelTreeItem")[0].dataset.webTreeNodeId).toContain("onclick");
    expect(tree.querySelectorAll("script")).toEqual([]);
    expect(tree.querySelectorAll("img")).toEqual([]);
    // Unknown icons normalize to the host's inert file icon.
    expect(parseWebPanelTree(JSON.stringify([{ id: "x", label: "x", icon: "evil" }]))?.[0].icon).toBe("file");

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const malformed = placeholder(document, `[{"id":"broken","label":]`);
    malformed.target.append(document.createElement("script"));
    expect(() => expand(malformed.root)).not.toThrow();
    expect(malformed.root.children[0]).toBe(malformed.target);
    expect(malformed.target.children).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("persists directory expansion by panel key and stable id across rerenders", () => {
    const document = new TestDocument();
    const json = JSON.stringify([{ id: "folder", label: "Folder", icon: "folder", open: true, children: [] }]);
    const first = placeholder(document, json);
    const state = expand(first.root);
    const details = byClass(first.root, "webPanelTreeDir")[0];
    details.open = false;
    details.dispatch("toggle");
    expect([...state.values()]).toEqual([false]);

    const second = placeholder(document, json);
    expand(second.root, state);
    expect(byClass(second.root, "webPanelTreeDir")[0].open).toBe(false);
    expect(byClass(second.root, "webPanelTreeDirLabel")[0].getAttribute("aria-expanded")).toBe("false");
  });
});

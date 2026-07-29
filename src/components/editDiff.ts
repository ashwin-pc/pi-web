import { Columns2, createElement, Rows2 } from "lucide";
import { diffHunkLineCount, renderDiffHunks, renderNumberedDiff, setDiffLayout } from "./diff.js";

const editArgsByCard = new WeakMap<HTMLDivElement, Record<string, unknown>>();

function resultDiff(result: unknown) {
  if (!result || typeof result !== "object") return undefined;
  const value = result as Record<string, unknown>;
  const raw = value.raw && typeof value.raw === "object" ? value.raw as Record<string, unknown> : undefined;
  const details = (value.details && typeof value.details === "object" ? value.details : raw?.details) as Record<string, unknown> | undefined;
  return typeof details?.diff === "string" ? details.diff : undefined;
}

function normalizeEditHunks(args: Record<string, unknown>) {
  let edits = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits) as unknown;
    } catch {
      edits = undefined;
    }
  }
  if (!Array.isArray(edits) && ("oldText" in args || "newText" in args)) {
    edits = [{ oldText: args.oldText, newText: args.newText }];
  }
  if (!Array.isArray(edits)) return [];
  return edits
    .filter((hunk): hunk is Record<string, unknown> => !!hunk && typeof hunk === "object")
    .map((hunk) => ({ oldText: hunk.oldText, newText: hunk.newText }));
}

function updateLayoutToggle(button: HTMLButtonElement, stacked: boolean) {
  button.replaceChildren(createElement(stacked ? Columns2 : Rows2, { "aria-hidden": "true" }));
  const label = stacked ? "Switch to side-by-side diff view" : "Switch to top/bottom diff view";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function updateCollapseToggle(button: HTMLButtonElement, collapsed: boolean) {
  button.textContent = "";
  button.setAttribute("aria-label", collapsed ? "Show more" : "Show less");
  button.title = collapsed ? "Show more" : "Show less";
  button.setAttribute("aria-expanded", String(!collapsed));
}

export function renderEditDiff(card: HTMLDivElement, args: Record<string, unknown>, result?: unknown) {
  if (Object.keys(args).length > 0) editArgsByCard.set(card, args);
  const edits = normalizeEditHunks(editArgsByCard.get(card) || args);
  const numberedDiff = resultDiff(result);
  if (edits.length === 0 && !numberedDiff) return;

  card.querySelectorAll(":scope > .diffToolbar, :scope > .diffContainer, :scope > .toolCardCollapseToggle").forEach((element) => element.remove());
  const toolbar = document.createElement("div");
  toolbar.className = "diffToolbar";
  const label = document.createElement("span");
  label.textContent = `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
  const layout = document.createElement("button");
  layout.type = "button";
  layout.className = "diffLayoutToggle";

  let stacked = window.matchMedia("(max-width: 700px)").matches;
  const container = numberedDiff ? renderNumberedDiff(numberedDiff, { stacked }) : renderDiffHunks(edits, { stacked });
  updateLayoutToggle(layout, stacked);
  layout.addEventListener("click", () => {
    stacked = !stacked;
    setDiffLayout(container, stacked);
    updateLayoutToggle(layout, stacked);
  });
  toolbar.append(label, layout);

  const collapsible = numberedDiff ? numberedDiff.split("\n").length > 20 : diffHunkLineCount(edits) > 20;
  if (collapsible) container.classList.add("collapsed");
  card.append(toolbar, container);

  if (collapsible) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "toolCardCollapseToggle";
    const setCollapsed = (collapsed: boolean) => {
      container.classList.toggle("collapsed", collapsed);
      updateCollapseToggle(toggle, collapsed);
    };
    setCollapsed(true);
    container.addEventListener("click", () => setCollapsed(!container.classList.contains("collapsed")));
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      setCollapsed(!container.classList.contains("collapsed"));
    });
    card.append(toggle);
  }
}

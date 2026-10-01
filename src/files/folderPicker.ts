import { iconElement } from "../app/icons.js";

export type FolderListing = { path: string; parent?: string | null; dirs: Array<{ name: string; path: string }> };
export type FolderPickerApi = {
  list: (path: string, signal: AbortSignal) => Promise<FolderListing>;
  create: (parent: string, name: string) => Promise<string>;
  select: (path: string) => Promise<void>;
};

const recentFoldersKey = "pi-web-recent-folders";
const recentLimit = 8;
let closeActiveFolderPicker: (() => void) | undefined;
type RecentFolder = { path: string; usedAt: string };

export function readRecentFolders(storage: Pick<Storage, "getItem"> = localStorage): RecentFolder[] {
  try {
    const value = JSON.parse(storage.getItem(recentFoldersKey) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is RecentFolder => Boolean(item && typeof item.path === "string" && item.path.trim() && typeof item.usedAt === "string"))
      .slice(0, recentLimit);
  } catch { return []; }
}

export function rememberRecentFolder(path: string, storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
  const clean = path.trim();
  if (!clean) return;
  const next = [{ path: clean, usedAt: new Date().toISOString() }, ...readRecentFolders(storage).filter((item) => item.path !== clean)].slice(0, recentLimit);
  try { storage.setItem(recentFoldersKey, JSON.stringify(next)); } catch { /* Optional browser storage. */ }
}

function folderName(path: string) { return path.split(/[\\/]+/).filter(Boolean).at(-1) || path || "Folder"; }
function parentPath(path: string) { const parts = path.split("/").filter(Boolean); return parts.length <= 1 ? "/" : `/${parts.slice(0, -1).join("/")}`; }
function button(label: string, className: string, icon?: Parameters<typeof iconElement>[0]) {
  const el = document.createElement("button"); el.type = "button"; el.className = className; el.setAttribute("aria-label", label);
  if (icon) el.append(iconElement(icon));
  return el;
}
function relativeTime(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "Just now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86400)}d ago`;
}

export function openFolderPicker(options: {
  startPath: string;
  api: FolderPickerApi;
  getBookmarks: () => string[];
  setBookmarks: (paths: string[]) => void;
  onClose?: () => void;
}) {
  closeActiveFolderPicker?.();
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const backdrop = document.createElement("div"); backdrop.className = "folderPickerBackdrop";
  const modal = document.createElement("section"); modal.className = "folderPicker"; modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "folderPickerTitle");
  const header = document.createElement("header"); header.className = "folderPickerHeader";
  const title = document.createElement("h2"); title.id = "folderPickerTitle"; title.textContent = "Folder";
  const closeButton = button("Close folder picker", "folderPickerIcon", "x"); header.append(title, closeButton);
  const body = document.createElement("div"); body.className = "folderPickerBody";
  const errorRegion = document.createElement("p"); errorRegion.className = "folderPickerError"; errorRegion.hidden = true; errorRegion.setAttribute("role", "alert");
  const live = document.createElement("div"); live.className = "visuallyHidden"; live.setAttribute("aria-live", "polite");
  modal.append(header, body, errorRegion, live); backdrop.append(modal); document.body.append(backdrop);

  let mode: "quick" | "browse" = "quick";
  let current = options.startPath;
  let listing: FolderListing | undefined;
  let request: AbortController | undefined;
  let closed = false;
  let editing = false;
  let loading = false;
  let loadFailed = false;
  let selecting = false;
  const say = (message: string) => { live.textContent = ""; requestAnimationFrame(() => { live.textContent = message; }); };
  const bookmarks = () => Array.from(new Set(options.getBookmarks().filter(Boolean)));
  const setBookmarks = (paths: string[]) => options.setBookmarks(Array.from(new Set(paths.filter(Boolean))));

  function clearError() { errorRegion.hidden = true; errorRegion.textContent = ""; }
  function close(force = false) {
    if (closed || (selecting && !force)) return; closed = true; request?.abort(); document.removeEventListener("keydown", onKeyDown, true); backdrop.remove(); if (closeActiveFolderPicker === forceClose) closeActiveFolderPicker = undefined; options.onClose?.(); restoreFocus?.focus();
  }
  const forceClose = () => close(true);
  closeActiveFolderPicker = forceClose;
  function showError(message: string) { errorRegion.textContent = message; errorRegion.hidden = false; say(message); }
  async function choose(path: string) {
    if (selecting || closed) return;
    selecting = true; modal.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; }); clearError();
    try { await options.api.select(path); if (closed) return; rememberRecentFolder(path); selecting = false; close(); }
    catch (error) { if (closed) return; selecting = false; render(); showError(error instanceof Error ? error.message : String(error)); }
  }
  function toggleBookmark(path: string) {
    const saved = bookmarks(); const exists = saved.includes(path); setBookmarks(exists ? saved.filter((item) => item !== path) : [path, ...saved]);
    say(`${folderName(path)} ${exists ? "removed from" : "added to"} favorites`); render();
    if (mode === "browse") requestAnimationFrame(() => modal.querySelector<HTMLButtonElement>('[aria-label$="current folder from favorites"], [aria-label$="current folder to favorites"]')?.focus());
  }
  function savedRow(path: string, favorite: boolean, age?: string) {
    const wrapper = document.createElement("div"); wrapper.className = favorite ? "folderPickerFavorite" : "folderPickerRecent";
    const use = button(`Use ${folderName(path)}`, favorite ? "folderPickerTile" : "folderPickerSavedRow", "folder-tree");
    const text = document.createElement("span"); const strong = document.createElement("strong"); strong.textContent = folderName(path); const small = document.createElement("small"); small.textContent = favorite ? parentPath(path) : path; text.append(strong, small); use.append(text);
    if (age) { const when = document.createElement("span"); when.className = "folderPickerAge"; when.textContent = age; use.append(when); }
    use.title = path; use.addEventListener("click", () => void choose(path)); wrapper.append(use);
    if (favorite) { const star = button(`Remove ${folderName(path)} from favorites`, "folderPickerStar", "star"); star.setAttribute("aria-pressed", "true"); star.addEventListener("click", () => toggleBookmark(path)); wrapper.append(star); }
    return wrapper;
  }
  function renderQuick() {
    request?.abort(); request = undefined; loading = false; loadFailed = false; clearError();
    body.textContent = ""; body.className = "folderPickerBody folderPickerQuick";
    const searchLabel = document.createElement("label"); searchLabel.className = "folderPickerSearch"; searchLabel.append(iconElement("funnel"));
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "Search saved folders"; search.setAttribute("aria-label", "Search saved folders"); searchLabel.append(search);
    const favoritesSection = document.createElement("section"); const favoritesTitle = document.createElement("h3"); favoritesTitle.textContent = "Favorites"; const favoritesGrid = document.createElement("div"); favoritesGrid.className = "folderPickerFavorites"; favoritesSection.append(favoritesTitle, favoritesGrid);
    const recentSection = document.createElement("section"); const recentTitle = document.createElement("h3"); recentTitle.textContent = "Recent"; const recentRows = document.createElement("div"); recentRows.className = "folderPickerSavedRows"; recentSection.append(recentTitle, recentRows);
    const browse = button("Browse folders", "folderPickerBrowseButton", "folder-tree"); browse.append(document.createTextNode("Browse folders")); browse.addEventListener("click", () => { mode = "browse"; void load(current, "back"); });
    body.append(searchLabel, favoritesSection, recentSection, browse);
    const draw = () => {
      const query = search.value.trim().toLowerCase(); const favs = bookmarks().filter((path) => !query || path.toLowerCase().includes(query));
      const recents = readRecentFolders().filter((item) => !bookmarks().includes(item.path) && (!query || item.path.toLowerCase().includes(query)));
      favoritesGrid.replaceChildren(...favs.map((path) => savedRow(path, true)));
      recentRows.replaceChildren(...recents.map((item) => savedRow(item.path, false, relativeTime(item.usedAt))));
      if (!favs.length) { const empty = document.createElement("p"); empty.className = "folderPickerEmpty"; empty.textContent = query ? "No matching favorites." : "No favorites yet."; favoritesGrid.append(empty); }
      if (!recents.length) { const empty = document.createElement("p"); empty.className = "folderPickerEmpty"; empty.textContent = query ? "No saved folders found." : "No recent folders."; recentRows.append(empty); }
    };
    search.addEventListener("input", draw); draw();
    if (!window.matchMedia("(max-width: 640px), (pointer: coarse)").matches) requestAnimationFrame(() => search.focus());
  }
  function renderBreadcrumbs(container: HTMLElement) {
    const parts = current.split("/").filter(Boolean); const paths = ["/", ...parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`)];
    paths.forEach((path, index) => { if (index) { const slash = document.createElement("span"); slash.textContent = "/"; slash.className = "folderPickerSlash"; container.append(slash); } const crumb = button(`Open ${path}`, "folderPickerCrumb"); crumb.textContent = index ? parts[index - 1] : "/"; if (path === current) crumb.setAttribute("aria-current", "location"); crumb.addEventListener("click", () => void load(path)); container.append(crumb); });
  }
  function renderBrowse() {
    body.textContent = ""; body.className = "folderPickerBody folderPickerBrowse";
    const bar = document.createElement("div"); bar.className = "folderPickerBar";
    if (editing) {
      const pathInput = document.createElement("input"); pathInput.className = "folderPickerInput"; pathInput.value = current; pathInput.setAttribute("aria-label", "Folder path");
      const cancelEdit = button("Cancel path edit", "folderPickerIcon", "x");
      const stopEdit = () => { editing = false; renderBrowse(); modal.querySelector<HTMLButtonElement>('[aria-label="Edit folder path"]')?.focus(); };
      cancelEdit.addEventListener("click", stopEdit); pathInput.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); stopEdit(); } else if (event.key === "Enter") { event.preventDefault(); void load(pathInput.value.trim()); } });
      bar.append(pathInput, cancelEdit); requestAnimationFrame(() => { pathInput.focus(); pathInput.select(); });
    } else {
      const back = button("Back to saved folders", "folderPickerIcon", "arrow-left"); back.addEventListener("click", () => { mode = "quick"; renderQuick(); requestAnimationFrame(() => modal.querySelector<HTMLButtonElement>(".folderPickerBrowseButton")?.focus()); });
      const crumbs = document.createElement("nav"); crumbs.className = "folderPickerCrumbs"; crumbs.setAttribute("aria-label", "Current folder path"); renderBreadcrumbs(crumbs);
      const star = button(bookmarks().includes(current) ? "Remove current folder from favorites" : "Add current folder to favorites", "folderPickerIcon", "star"); star.setAttribute("aria-pressed", String(bookmarks().includes(current))); star.classList.toggle("active", bookmarks().includes(current)); star.disabled = loading || loadFailed || !listing; star.addEventListener("click", () => toggleBookmark(current));
      const edit = button("Edit folder path", "folderPickerIcon", "square-pen"); edit.addEventListener("click", () => { editing = true; renderBrowse(); }); bar.append(back, crumbs, star, edit);
    }
    const content = document.createElement("div"); content.className = "folderPickerContent";
    const rail = document.createElement("aside"); rail.className = "folderPickerRail"; const railTitle = document.createElement("h3"); railTitle.textContent = "Saved"; rail.append(railTitle);
    for (const path of bookmarks()) { const item = button(`Open ${path}`, `folderPickerNav${path === current ? " active" : ""}`, "folder-tree"); const label = document.createElement("span"); label.textContent = folderName(path); item.append(label); item.title = path; item.addEventListener("click", () => void load(path)); rail.append(item); }
    const files = document.createElement("div"); files.className = "folderPickerFiles"; files.setAttribute("aria-label", "Folders");
    if (!listing) { const status = document.createElement("p"); status.className = "folderPickerEmpty"; status.textContent = loadFailed ? "Folder unavailable." : "Loading folders…"; files.append(status); }
    else if (!listing.dirs.length) { const empty = document.createElement("p"); empty.className = "folderPickerEmpty"; empty.textContent = "No subfolders."; files.append(empty); }
    else for (const dir of listing.dirs) { const row = button(`Open ${dir.path}`, "folderPickerFile", "folder-tree"); const label = document.createElement("span"); label.textContent = dir.name; const chevron = iconElement("chevron-right"); row.append(label, chevron); row.addEventListener("click", () => void load(dir.path)); files.append(row); }
    content.append(rail, files);
    const footer = document.createElement("footer"); footer.className = "folderPickerFooter";
    const create = button("Create new folder", "folderPickerCreate"); create.textContent = "New folder"; create.disabled = loading || loadFailed || !listing;
    const cancel = button("Cancel", "folderPickerCancel"); cancel.textContent = "Cancel"; cancel.addEventListener("click", () => close());
    const select = button(`Use ${current}`, "folderPickerSelect"); select.textContent = `Use ${folderName(current)}`; select.disabled = loading || loadFailed || !listing; select.addEventListener("click", () => void choose(current));
    create.addEventListener("click", () => beginCreate(files, create)); footer.append(create, cancel, select); body.append(bar, content, footer);
  }
  function beginCreate(files: HTMLElement, trigger: HTMLButtonElement) {
    if (files.querySelector(".folderPickerCreateRow")) return;
    const form = document.createElement("form"); form.className = "folderPickerCreateRow"; const input = document.createElement("input"); input.placeholder = "Folder name"; input.setAttribute("aria-label", "New folder name");
    const save = button("Create folder", "folderPickerCreateConfirm", "check"); save.addEventListener("click", () => form.requestSubmit()); const cancel = button("Cancel new folder", "folderPickerIcon", "x"); form.append(input, save, cancel); files.prepend(form);
    const stop = () => { form.remove(); trigger.focus(); }; cancel.addEventListener("click", stop); input.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); stop(); } });
    form.addEventListener("submit", async (event) => { event.preventDefault(); const name = input.value.trim(); if (!name) return; save.disabled = true; try { const path = await options.api.create(current, name); await load(path); } catch (error) { showError(error instanceof Error ? error.message : String(error)); save.disabled = false; input.focus(); } }); input.focus();
  }
  async function load(path: string, focusAfter: "back" | "location" = "location") {
    if (!path || selecting) return; request?.abort(); const ownRequest = new AbortController(); request = ownRequest; listing = undefined; loading = true; loadFailed = false; editing = false; mode = "browse"; clearError(); renderBrowse();
    try {
      const result = await options.api.list(path, ownRequest.signal); if (closed || ownRequest.signal.aborted || request !== ownRequest || mode !== "browse") return;
      current = result.path; listing = result; loading = false; renderBrowse(); say(`Opened ${result.path}`);
      requestAnimationFrame(() => modal.querySelector<HTMLButtonElement>(focusAfter === "back" ? '[aria-label="Back to saved folders"]' : '.folderPickerCrumb[aria-current]')?.focus());
    } catch (error) {
      if (ownRequest.signal.aborted || closed || request !== ownRequest || mode !== "browse") return;
      loading = false; loadFailed = true; listing = undefined; renderBrowse(); showError(error instanceof Error ? error.message : String(error));
    }
  }
  function render() { mode === "quick" ? renderQuick() : renderBrowse(); }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && !editing && !modal.querySelector(".folderPickerCreateRow") && !selecting) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "Tab") return; const focusable = Array.from(modal.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')); if (!focusable.length) return; const first = focusable[0], last = focusable.at(-1)!; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", onKeyDown, true); closeButton.addEventListener("click", () => close()); backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); }); render();
  return { close: () => close() };
}

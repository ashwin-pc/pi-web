const favoritesKey = "pi-web.model-favorites";

export function createModelPicker(select: HTMLSelectElement, onSelect?: () => void) {
  let favorites = new Set<string>();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(favoritesKey) || "[]");
    if (Array.isArray(saved)) favorites = new Set(saved.filter((key): key is string => typeof key === "string"));
  } catch { /* Storage may be unavailable. Favorites still work in memory. */ }

  const root = document.createElement("div");
  root.className = "modelPicker";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search models or providers…";
  search.setAttribute("aria-label", "Search models or providers");
  const list = document.createElement("div");
  list.className = "modelPickerList";
  list.setAttribute("aria-label", "Models");
  const status = document.createElement("div");
  status.className = "modelSettingsHint";
  status.setAttribute("role", "status");
  const filters = document.createElement("div");
  filters.className = "modelPickerFilters";
  const provider = document.createElement("select");
  provider.setAttribute("aria-label", "Filter by provider");
  const favoritesOnly = document.createElement("button");
  favoritesOnly.type = "button";
  favoritesOnly.textContent = "★ Favorites only";
  favoritesOnly.setAttribute("aria-pressed", "false");
  filters.append(provider, favoritesOnly);
  const pagination = document.createElement("div");
  pagination.className = "modelPickerPagination";
  const previous = document.createElement("button");
  previous.type = "button";
  previous.textContent = "Previous";
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "Next";
  const pageLabel = document.createElement("span");
  pagination.append(previous, pageLabel, next);
  let page = 0;
  const pageSize = 40;
  root.append(status, search, filters, list, pagination);
  const field = select.closest<HTMLElement>("label");
  if (field) {
    field.hidden = true;
    field.parentElement?.append(root);
  }

  function render() {
    const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const all = Array.from(select.options).filter(option => option.value);
    const providerOf = (option: HTMLOptionElement) => option.dataset.provider || option.value.split("/")[0];
    const selectedProvider = provider.value;
    const counts = new Map<string, number>();
    for (const option of all) counts.set(providerOf(option), (counts.get(providerOf(option)) || 0) + 1);
    provider.replaceChildren(new Option(`All providers (${all.length})`, ""));
    for (const [name, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
      provider.append(new Option(`${name} (${count})`, name));
    }
    provider.value = counts.has(selectedProvider) ? selectedProvider : "";
    const options = all.filter(option => (!provider.value || providerOf(option) === provider.value)
      && (favoritesOnly.getAttribute("aria-pressed") !== "true" || favorites.has(option.value))
      && terms.every(term => `${option.value} ${option.textContent}`.toLowerCase().includes(term)))
      .sort((a, b) => Number(favorites.has(b.value)) - Number(favorites.has(a.value))
        || providerOf(a).localeCompare(providerOf(b)) || (a.textContent || a.value).localeCompare(b.textContent || b.value));
    page = Math.min(page, Math.max(0, Math.ceil(options.length / pageSize) - 1));
    const visible = options.slice(page * pageSize, (page + 1) * pageSize);
    const focused = document.activeElement as HTMLElement | null;
    const focusKey = focused?.dataset.favoriteKey || focused?.dataset.modelKey;
    const focusSelector = focused?.dataset.favoriteKey ? "[data-favorite-key]" : "[data-model-key]";
    const scrollTop = list.scrollTop;
    const groups = new Map<string, HTMLOptionElement[]>();
    for (const option of visible) {
      const group = favorites.has(option.value) ? "★ Favorites" : option.dataset.provider || option.value.split("/")[0];
      const items = groups.get(group) || [];
      items.push(option);
      groups.set(group, items);
    }
    list.replaceChildren();
    for (const group of [...groups.keys()].sort((a, b) => a === "★ Favorites" ? -1 : b === "★ Favorites" ? 1 : a.localeCompare(b))) {
      const heading = document.createElement("div");
      heading.className = "modelPickerHeading";
      heading.textContent = group;
      list.append(heading);
      for (const option of groups.get(group)!) {
        const row = document.createElement("div");
        row.className = "modelPickerRow";
        const choose = document.createElement("button");
        choose.type = "button";
        choose.className = "modelPickerChoice";
        choose.disabled = select.disabled;
        choose.dataset.modelKey = option.value;
        choose.setAttribute("aria-pressed", String(option.selected));
        choose.title = option.textContent || option.value;
        const name = document.createElement("strong");
        name.textContent = option.dataset.modelName || option.dataset.modelId || option.value;
        const detail = document.createElement("small");
        detail.textContent = option.value;
        choose.append(name, detail);
        choose.addEventListener("click", () => {
          if (select.disabled) return;
          const changed = select.value !== option.value;
          if (changed) {
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
          (document.activeElement as HTMLElement | null)?.blur();
          onSelect?.();
        });
        const star = document.createElement("button");
        star.type = "button";
        star.className = "modelPickerStar";
        star.textContent = favorites.has(option.value) ? "★" : "☆";
        star.setAttribute("aria-pressed", String(favorites.has(option.value)));
        star.setAttribute("aria-label", `${favorites.has(option.value) ? "Unfavorite" : "Favorite"} ${option.value}`);
        star.title = star.getAttribute("aria-label")!;
        star.dataset.favoriteKey = option.value;
        star.addEventListener("click", () => {
          if (!favorites.delete(option.value)) favorites.add(option.value);
          try { localStorage.setItem(favoritesKey, JSON.stringify([...favorites])); } catch { /* Keep in-memory favorites. */ }
          render();
          Array.from(list.querySelectorAll<HTMLButtonElement>("[data-favorite-key]")).find(button => button.dataset.favoriteKey === option.value)?.focus();
        });
        row.append(choose, star);
        list.append(row);
      }
    }
    list.scrollTop = scrollTop;
    if (focusKey) {
      const target = Array.from(list.querySelectorAll<HTMLButtonElement>(focusSelector))
        .find(button => (button.dataset.favoriteKey || button.dataset.modelKey) === focusKey);
      (target || favoritesOnly).focus({ preventScroll: true });
    }
    status.textContent = options.length
      ? `${options.length} models · Star your favorites to keep them on top.`
      : favoritesOnly.getAttribute("aria-pressed") === "true" && !favorites.size
        ? "No favorites yet. Switch off Favorites only and star a model."
        : "No matching models.";
    pagination.hidden = options.length <= pageSize;
    previous.disabled = page === 0;
    next.disabled = (page + 1) * pageSize >= options.length;
    pageLabel.textContent = `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, options.length)} of ${options.length}`;
  }
  function resetResults() { page = 0; list.scrollTop = 0; render(); }
  search.addEventListener("input", resetResults);
  provider.addEventListener("change", resetResults);
  favoritesOnly.addEventListener("click", () => {
    favoritesOnly.setAttribute("aria-pressed", String(favoritesOnly.getAttribute("aria-pressed") !== "true"));
    resetResults();
  });
  function changePage(delta: number) {
    page += delta;
    list.scrollTop = 0;
    render();
    list.querySelector<HTMLButtonElement>(".modelPickerChoice:not(:disabled)")?.focus();
  }
  previous.addEventListener("click", () => changePage(-1));
  next.addEventListener("click", () => changePage(1));
  search.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault();
      list.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
  });
  list.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>(".modelPickerChoice:not(:disabled)"));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
    if (index === 0 && event.key === "ArrowUp") search.focus();
  });
  return { render, open: () => { search.value = ""; provider.value = ""; resetResults(); } };
}

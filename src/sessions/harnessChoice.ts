import type { HarnessCatalogDto, HarnessId } from "../../server/session/dto.js";

/** Both creation flows use the same opt-in choices; changing a choice never mutates a session. */
export function harnessChoice(catalog: HarnessCatalogDto, selected: HarnessId, placement: "landing" | "dialog", onChange: (id: HarnessId) => void) {
  const label = document.createElement("label");
  label.className = placement === "landing" ? "emptyCwdButton emptyHarnessControl" : "newSessionFieldLabel";
  label.dataset.harnessSelector = placement;
  const name = document.createElement("span"); name.textContent = "Harness";
  const select = document.createElement("select");
  select.className = placement === "dialog" ? "newSessionFieldSelect harnessSelect" : "harnessSelect";
  select.setAttribute("aria-label", "Session harness");
  for (const harness of catalog.harnesses) {
    const available = harness.enabled && harness.available;
    const option = new Option(available ? harness.name : `${harness.name} — ${harness.unavailableReason || "Not enabled on this server"}`, harness.id);
    option.disabled = !available;
    select.append(option);
  }
  select.value = selected;
  // Never silently substitute Pi for a selected harness removed from the catalog.
  if (select.value !== selected) {
    const missing = new Option(`${selected} — unavailable`, selected); missing.disabled = true;
    select.append(missing); select.value = selected;
  }
  select.addEventListener("change", () => onChange(select.value as HarnessId));
  label.append(name, select);
  return { label, select };
}

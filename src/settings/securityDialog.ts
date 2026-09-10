// Native modal focus containment, Escape cancellation, and focus restoration.
// Resolve only on an explicit confirmation; no security operation runs on close.
export function confirmSecurityAction(options: {
  container: HTMLElement;
  title: string;
  detail: string;
  confirmLabel: string;
  tokens?: boolean;
}): Promise<{ revokeApiTokens: boolean } | undefined> {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "securityDialog";
    dialog.setAttribute("aria-labelledby", "securityConfirmTitle");
    dialog.setAttribute("aria-describedby", "securityConfirmDetail");
    const title = document.createElement("h3");
    title.id = "securityConfirmTitle";
    title.textContent = options.title;
    const detail = document.createElement("p");
    detail.id = "securityConfirmDetail";
    detail.textContent = options.detail;
    const label = document.createElement("label");
    label.className = "securityCheckbox";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    label.append(checkbox, "Also revoke API tokens. Automation will need new tokens.");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "securityWide danger";
    confirm.textContent = options.confirmLabel;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "securityWide securityQuiet";
    cancel.textContent = "Cancel";
    cancel.autofocus = true;
    let result: { revokeApiTokens: boolean } | undefined;
    confirm.onclick = () => { result = { revokeApiTokens: checkbox.checked }; dialog.close(); };
    cancel.onclick = () => dialog.close();
    dialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(result);
    }, { once: true });
    dialog.append(title, detail);
    if (options.tokens) dialog.append(label);
    dialog.append(confirm, cancel);
    options.container.append(dialog);
    dialog.showModal();
  });
}

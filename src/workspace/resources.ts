import { parseResourceRef, resourceFromUrl, type ResourceRef } from "../../shared/resourceRef.js";

export function configureResourceOpener(open: (ref: ResourceRef) => Promise<void>, onError: (error: unknown) => void) {
  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname) return;
    const resource = resourceFromUrl(url);
    if (!resource) return;
    event.preventDefault();
    void open(resource).catch(onError);
  });
  window.addEventListener("pi-web-open-resource", ((event: CustomEvent) => {
    const resource = parseResourceRef(event.detail);
    if (resource) void open(resource).catch(onError);
  }) as EventListener);
}

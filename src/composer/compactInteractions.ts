export const compactInactiveComposerSelector = ".composer.compactInactive:not(.expanded)";

type CompactPressOptions = {
  stopPropagation?: boolean;
  minIntervalMs?: number;
};

export function isCompactInactiveComposer(formEl: HTMLFormElement) {
  return formEl.matches(compactInactiveComposerSelector);
}

export function bindCompactInactiveAction(
  target: HTMLElement,
  formEl: HTMLFormElement,
  action: (event: Event) => void,
  options: CompactPressOptions = {},
) {
  let suppressNextClick = false;
  let lastHandledAt = 0;

  function suppressEvent(event: Event) {
    event.preventDefault();
    if (options.stopPropagation) event.stopPropagation();
  }

  function handlePress(event: Event) {
    if (!isCompactInactiveComposer(formEl)) return;

    const now = Date.now();
    if (now - lastHandledAt < (options.minIntervalMs ?? 700)) return;
    lastHandledAt = now;

    suppressEvent(event);
    suppressNextClick = true;
    action(event);
  }

  // A touchscreen emits pointerdown AND touchstart for the same gesture.
  // Prefer one event family instead of relying on a time gate to deduplicate.
  if (typeof window.PointerEvent !== "undefined") {
    target.addEventListener("pointerdown", handlePress);
  } else {
    target.addEventListener("mousedown", handlePress);
    target.addEventListener("touchstart", handlePress, { passive: false });
  }

  return function consumeSyntheticClick(event: Event) {
    // preventDefault on a touch press may suppress its click entirely. A later
    // keyboard activation must not be mistaken for that missing synthetic click.
    if (event instanceof MouseEvent && event.detail === 0) {
      suppressNextClick = false;
      return false;
    }
    if (!suppressNextClick) return false;
    suppressNextClick = false;
    suppressEvent(event);
    return true;
  };
}

export const compactInactiveComposerSelector = ".composer.compactInactive:not(:focus-within):not(.expanded)";

type CompactPressOptions = {
  stopPropagation?: boolean;
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
    if (now - lastHandledAt < 700) return;
    lastHandledAt = now;

    suppressEvent(event);
    suppressNextClick = true;
    action(event);
  }

  target.addEventListener("pointerdown", handlePress);
  target.addEventListener("mousedown", handlePress);
  target.addEventListener("touchstart", handlePress, { passive: false });

  return function consumeSyntheticClick(event: Event) {
    if (!suppressNextClick) return false;
    suppressNextClick = false;
    suppressEvent(event);
    return true;
  };
}

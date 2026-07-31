export function playToolCardEntry(card: HTMLElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  card.classList.add("toolCard--folioPending");
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!card.isConnected) return;
      card.classList.remove("toolCard--folioPending");
      card.classList.add("toolCard--folioEnter");
      card.addEventListener("animationend", () => card.classList.remove("toolCard--folioEnter"), { once: true });
    });
  });
}

export function playToolCardStateTransition(card: HTMLElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  card.classList.remove("toolCard--stateChanging");
  void card.offsetWidth;
  card.classList.add("toolCard--stateChanging");
  const header = card.querySelector<HTMLElement>(".toolCardHeader");
  header?.addEventListener("animationend", () => card.classList.remove("toolCard--stateChanging"), { once: true });
}

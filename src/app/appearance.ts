/** Whether the active appearance density is the most condensed option. */
export function isMinimalDensity(): boolean {
  return document.documentElement.dataset.density === "minimal";
}

/** Whether shared compact rendering should apply (compact and minimal). */
export function isCompactDensity(): boolean {
  const density = document.documentElement.dataset.density;
  return density === "compact" || density === "minimal";
}

export type ArtifactPreviewTheme = {
  tokens: Record<string, string>;
  colorScheme: "light" | "dark";
  density: "comfortable" | "compact" | "minimal";
};

const TOKEN_SOURCES = {
  "--pi-web-bg": "--bg",
  "--pi-web-panel": "--panel",
  "--pi-web-panel-2": "--panel-2",
  "--pi-web-border": "--border",
  "--pi-web-text": "--text",
  "--pi-web-muted": "--muted",
  "--pi-web-accent": "--accent",
  "--pi-web-danger": "--danger",
} as const;

function safeCssToken(value: string, max = 256) {
  const trimmed = value.trim();
  return trimmed.length <= max && !/[;{}<>]/.test(trimmed) ? trimmed : "";
}

export function readArtifactPreviewTheme(): ArtifactPreviewTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const typography = getComputedStyle(document.body || root);
  const tokens: Record<string, string> = {};
  for (const [target, source] of Object.entries(TOKEN_SOURCES)) {
    const value = safeCssToken(style.getPropertyValue(source));
    if (value) tokens[target] = value;
  }
  const family = safeCssToken(typography.fontFamily);
  const size = safeCssToken(typography.fontSize, 32);
  if (family) tokens["--pi-web-font-family"] = family;
  if (size) tokens["--pi-web-font-size"] = size;
  const scheme = style.colorScheme.toLowerCase();
  const density = root.dataset.density;
  return {
    tokens,
    colorScheme: scheme.includes("light") && !scheme.includes("dark") ? "light" : "dark",
    density: density === "compact" || density === "minimal" ? density : "comfortable",
  };
}

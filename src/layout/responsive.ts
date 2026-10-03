// Keep runtime panel behavior aligned with the media queries in appLayout.css.
// Panels are overlays through 1024px and become side panes at 1025px.
export const panelOverlayModeQuery = "(max-width: 1024px)";
export const panelPaneModeQuery = "(min-width: 1025px)";

// Session switching also dismisses the drawer in short landscape viewports.
export const sessionDrawerAutoCloseQuery = `${panelOverlayModeQuery}, (max-height: 520px)`;

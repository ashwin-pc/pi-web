export type CaptureChromeMetrics = {
  footerHeight: number;
  actionSize: number;
};

const cssPixels = (value: string) => {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) && pixels > 0 ? pixels : undefined;
};

/** Reads the expanded chrome contract while allowing the current footer to be compact. */
export function captureChromeMetrics(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
  measuredFooterHeight: number,
): CaptureChromeMetrics {
  const footerHeight = cssPixels(style.getPropertyValue("--composer-footer-height")) ?? measuredFooterHeight;
  const actionSize = cssPixels(style.getPropertyValue("--composer-action-size")) ?? footerHeight;
  return { footerHeight, actionSize };
}

/** Pure target geometry, kept separate so alternate CSS sizes remain regression-testable. */
export function captureChromeTargets(metrics: CaptureChromeMetrics, captureButtonCount: number) {
  return {
    footerHeight: metrics.footerHeight,
    actionSize: metrics.actionSize,
    actionWidthStart: 0,
    actionWidthEnd: metrics.actionSize,
    settlingInputWidth: (captureButtonCount + 1) * metrics.actionSize,
    idleInputWidth: captureButtonCount * metrics.actionSize,
  };
}

export function createComposerCaptureLayout(
  composer: HTMLElement,
  footer: HTMLElement | null,
  captureInputs: HTMLElement,
) {
  let pinned = false;
  let pinnedModelGeometry: DOMRect | undefined;

  const model = () => composer.querySelector<HTMLElement>(".modelControl");
  const targets = () => {
    const measured = footer?.getBoundingClientRect().height || composer.getBoundingClientRect().height;
    const metrics = captureChromeMetrics(getComputedStyle(composer), measured);
    return captureChromeTargets(metrics, captureInputs.querySelectorAll(".composerCaptureButton").length);
  };

  function pin() {
    if (!footer) return;
    const composerRect = composer.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const modelElement = model();
    const modelRect = modelElement?.getBoundingClientRect();
    pinnedModelGeometry = modelRect;
    Object.assign(footer.style, {
      position: "absolute",
      left: `${footerRect.left - composerRect.left - 1}px`,
      bottom: `${composerRect.bottom - footerRect.bottom - 1}px`,
      width: `${footerRect.width}px`,
      height: `${footerRect.height}px`,
      zIndex: "3",
    });
    composer.dataset.captureChrome = "settling";
    composer.style.setProperty("--capture-chrome-action-width", `${targets().actionWidthStart}px`);
    const captureWidth = captureInputs.getBoundingClientRect().width;
    captureInputs.style.width = `${captureWidth}px`;
    captureInputs.style.flex = `0 0 ${captureWidth}px`;
    captureInputs.style.overflow = "hidden";
    footer.getBoundingClientRect();
    if (modelElement && modelRect) {
      const slotDelta = modelRect.width - modelElement.getBoundingClientRect().width;
      if (Math.abs(slotDelta) > .01) {
        footer.style.width = `${footerRect.width + slotDelta}px`;
        footer.getBoundingClientRect();
      }
    }
    pinned = true;
  }

  function settle() {
    if (!pinned || !footer) return;
    const modelElement = model();
    if (modelElement && pinnedModelGeometry) {
      const currentModel = modelElement.getBoundingClientRect();
      const currentFooter = footer.getBoundingClientRect();
      footer.style.transition = "none";
      footer.style.width = `${currentFooter.width + pinnedModelGeometry.width - currentModel.width}px`;
      footer.style.left = `${parseFloat(footer.style.left || "0") + pinnedModelGeometry.x - currentModel.x}px`;
      footer.getBoundingClientRect();
    }
    const target = targets();
    composer.style.paddingBottom = `${target.footerHeight}px`;
    footer.style.transition = "left 140ms linear, bottom 140ms linear, width 140ms linear, height 140ms linear";
    footer.style.left = "0px";
    footer.style.bottom = "0px";
    footer.style.width = "100%";
    footer.style.height = `${target.footerHeight}px`;
    composer.style.setProperty("--capture-chrome-action-width", `${target.actionWidthEnd}px`);
    captureInputs.style.transition = "width 140ms linear, flex-basis 140ms linear";
    captureInputs.style.width = `${target.settlingInputWidth}px`;
    captureInputs.style.flexBasis = `${target.settlingInputWidth}px`;
  }

  function prepareIdle() {
    if (!pinned) return;
    const target = targets();
    captureInputs.style.transition = "none";
    captureInputs.style.width = `${target.idleInputWidth}px`;
    captureInputs.style.flexBasis = `${target.idleInputWidth}px`;
  }

  function release() {
    if (!pinned || !footer) return;
    for (const property of ["position", "left", "bottom", "width", "height", "z-index", "transition"]) footer.style.removeProperty(property);
    delete composer.dataset.captureChrome;
    composer.style.removeProperty("--capture-chrome-action-width");
    composer.style.removeProperty("padding-bottom");
    for (const property of ["width", "flex", "flex-basis", "overflow", "transition"]) captureInputs.style.removeProperty(property);
    pinnedModelGeometry = undefined;
    pinned = false;
  }

  return { pin, settle, prepareIdle, release, isPinned: () => pinned };
}

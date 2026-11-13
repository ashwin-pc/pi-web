// Camera/navigation owns its state; rendering consumes snapshots on demand.
function createStlCamera(canvas, render) {
  let angle = [-0.58, 2.4],
    pan = [0, 0],
    zoom = 1;
  const markView = (view) => {
    for (const button of document.querySelectorAll("[data-view]"))
      button.setAttribute("aria-pressed", String(button.dataset.view === view));
  };
  const fit = () => {
    pan = [0, 0];
    zoom = 1;
  };
  const resetView = () => {
    angle = [-0.58, 2.4];
    fit();
    markView("iso");
  };
  const pointers = new Map();
  let mode = "orbit";
  const zoomBy = (factor) => {
    zoom = Math.max(0.15, Math.min(10, zoom * factor));
  };
  const gesture = () => {
    const a = [...pointers.values()];
    return a.length < 2
      ? null
      : {
          x: (a[0][0] + a[1][0]) / 2,
          y: (a[0][1] + a[1][1]) / 2,
          d: Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]),
        };
  };
  canvas.onpointerdown = (e) => {
    e.preventDefault?.();
    mode =
      e.pointerType === "mouse" && (e.button || e.shiftKey) ? "pan" : "orbit";
    canvas.focus({ preventScroll: true });
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    const old = pointers.get(e.pointerId);
    if (!old) return;
    const before = gesture();
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const after = gesture();
    if (before && after) {
      pan[0] += ((after.x - before.x) / canvas.clientWidth) * 2;
      pan[1] -= ((after.y - before.y) / canvas.clientHeight) * 2;
      if (before.d > 0) zoomBy(after.d / before.d);
    } else {
      const dx = e.clientX - old[0],
        dy = e.clientY - old[1];
      if (mode === "pan") {
        pan[0] += (dx / canvas.clientWidth) * 2;
        pan[1] -= (dy / canvas.clientHeight) * 2;
      } else {
        angle[1] -= dx * 0.009;
        angle[0] -= dy * 0.009;
        markView(null);
      }
    }
    render();
  };
  canvas.onpointerup =
    canvas.onpointercancel =
    canvas.onlostpointercapture =
      (e) => {
        pointers.delete(e.pointerId);
      };
  canvas.oncontextmenu = (e) => e.preventDefault();
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.001));
      render();
    },
    { passive: false },
  );
  canvas.onkeydown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase(),
      step = 0.1;
    if (key === "f") {
      resetView();
    } else if (key === "+" || key === "=") {
      zoomBy(1.15);
    } else if (key === "-") {
      zoomBy(1 / 1.15);
    } else if (
      ["arrowleft", "arrowright", "arrowup", "arrowdown"].includes(key)
    ) {
      const dx = key === "arrowleft" ? -1 : key === "arrowright" ? 1 : 0,
        dy = key === "arrowup" ? 1 : key === "arrowdown" ? -1 : 0;
      if (e.shiftKey) {
        pan[0] += dx * 0.06;
        pan[1] += dy * 0.06;
      } else {
        angle[1] += dx * step;
        angle[0] += dy * step;
        markView(null);
      }
    } else return;
    e.preventDefault();
    render();
  };
  document.querySelector("#reset").onclick = () => {
    resetView();
    render();
  };
  for (const button of document.querySelectorAll("[data-view]"))
    button.onclick = () => {
      angle = {
        iso: [-0.58, 2.4],
        front: [0, 0],
        back: [0, Math.PI],
        left: [0, -Math.PI / 2],
        right: [0, Math.PI / 2],
        top: [-Math.PI / 2, 0],
        bottom: [Math.PI / 2, 0],
      }[button.dataset.view];
      fit();
      markView(button.dataset.view);
      document.querySelector("#view-menu").open = false;
      document.querySelector("#view-menu summary").focus();
      render();
    };
  markView("iso");
  return { fit, snapshot: () => ({ angle, pan, zoom }) };
}

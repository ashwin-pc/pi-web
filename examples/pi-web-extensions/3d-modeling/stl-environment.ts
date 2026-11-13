// Derived in the browser, never packed alongside the source mesh.
export function stlEnvironment(bounds: number[]) {
  const span =
    Math.max(
      bounds[3] - bounds[0],
      bounds[4] - bounds[1],
      bounds[5] - bounds[2],
    ) || 1;
  const cx = (bounds[0] + bounds[3]) / 2,
    cz = (bounds[2] + bounds[5]) / 2;
  const floorY = bounds[1] - span * 0.018,
    extent = span * 0.95;
  const ground: number[] = [],
    groundAlpha: number[] = [],
    grid: number[] = [],
    gridAlpha: number[] = [],
    shadow: number[] = [],
    shadowAlpha: number[] = [],
    box: number[] = [];
  for (let i = 0; i < 96; i++) {
    const a = (i * Math.PI) / 48,
      b = ((i + 1) * Math.PI) / 48;
    ground.push(
      cx,
      floorY,
      cz,
      cx + Math.cos(a) * extent * 1.5,
      floorY,
      cz + Math.sin(a) * extent * 1.5,
      cx + Math.cos(b) * extent * 1.5,
      floorY,
      cz + Math.sin(b) * extent * 1.5,
    );
    groundAlpha.push(1, 0, 0);
    const rx = Math.max(bounds[3] - bounds[0], span * 0.22) * 0.75,
      rz = Math.max(bounds[5] - bounds[2], span * 0.2) * 0.8;
    shadow.push(
      cx,
      floorY + span * 0.0006,
      cz,
      cx + Math.cos(a) * rx,
      floorY + span * 0.0006,
      cz + Math.sin(a) * rz,
      cx + Math.cos(b) * rx,
      floorY + span * 0.0006,
      cz + Math.sin(b) * rz,
    );
    shadowAlpha.push(1, 0, 0);
  }
  for (let i = -7; i <= 7; i++)
    for (let j = 0; j < 32; j++)
      for (const flip of [false, true])
        for (const t of [
          -extent + (j * extent) / 16,
          -extent + ((j + 1) * extent) / 16,
        ]) {
          const x = flip ? t : (i * span) / 8,
            z = flip ? (i * span) / 8 : t;
          grid.push(cx + x, floorY + span * 0.0003, cz + z);
          gridAlpha.push(Math.max(0, 1 - Math.hypot(x, z) / extent) ** 1.5);
        }
  for (let axis = 0; axis < 3; axis++)
    for (let side = 0; side < 4; side++) {
      const v = [0, 0, 0],
        other = [0, 1, 2].filter((x) => x !== axis);
      v[other[0]] = bounds[other[0] + (side & 1 ? 3 : 0)];
      v[other[1]] = bounds[other[1] + (side & 2 ? 3 : 0)];
      v[axis] = bounds[axis];
      box.push(...v);
      v[axis] = bounds[axis + 3];
      box.push(...v);
    }
  return {
    floorY,
    ground,
    groundAlpha,
    grid,
    gridAlpha,
    shadow,
    shadowAlpha,
    box,
  };
}
// Orthographic eye direction is -camera-depth, independent of pan and zoom.
// Fade before the horizon and skip all floor draws on/below it (no depth writes).
export function stlFloorFactor(depthY: number) {
  const t = Math.max(0, Math.min(1, -depthY / 0.22));
  return t * t * (3 - 2 * t);
}

// STL has no up-axis metadata. Explicit right-handed source-to-view basis only;
// the original scene remains Y-up and the source GPU buffers never change.
export function stlViewingBounds(bounds: number[], zUp: boolean) {
  return zUp ? [bounds[0], bounds[2], -bounds[4], bounds[3], bounds[5], -bounds[1]] : bounds.slice();
}
export function stlViewingRotation(r: number[], zUp: boolean) {
  return zUp ? [r[0],r[1],r[2],-r[6],-r[7],-r[8],r[3],r[4],r[5]] : r.slice();
}

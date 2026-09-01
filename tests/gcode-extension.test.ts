import { describe, expect, it } from "vitest";
import { gcodePreviewTest } from "../examples/pi-web-extensions/3d-modeling/gcode.js";

const { parse, viewer, MAX_SEGMENTS } = gcodePreviewTest;

function packed(html: string) {
  const match = html.match(/<script>const M=(.*?),raw=atob\(M\.p\)/s);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as {
    p: string; k: string; layers: Array<{ z: number; start: number; line: number }>;
    sourceSegments: number;
  };
}

function fixture(pattern = "rectilinear") {
  return `; fill_pattern = ${pattern}
G90
M82
;LAYER_CHANGE
;Z:0.2
G1 X0 Y0 Z0.2
;TYPE:Perimeter
G1 X10 Y0 E1
;TYPE:External perimeter
G1 X10 Y10 E2
;TYPE:Internal infill
G1 X0 Y10 E3
;LAYER:1
;Z:0.4
G1 X0 Y0 Z0.4
;TYPE:External perimeter
G1 X5 Y5 E4
`;
}

function manyInfill(pattern: string, count: number) {
  const lines = [`; fill_pattern = ${pattern}`, "G90", "M82", ";LAYER_CHANGE", ";Z:0.2", "G1 X0 Y0 Z0.2", ";TYPE:Internal infill"];
  for (let i = 1; i <= count; i++) lines.push(`G1 X${i % 200} Y${Math.floor(i / 200) % 200} E${i}`);
  return `${lines.join("\n")}\n`;
}

describe("3D modeling G-code preview", () => {
  it("keeps layer markers and exposes separate Layer/Z and move-in-layer controls", () => {
    const model = parse(fixture());
    expect(model.layers).toHaveLength(2);
    expect(model.layers.map((layer) => layer.z)).toEqual([0.2, 0.4]);
    expect(model.layers[1].start).toBeGreaterThan(model.layers[0].start);

    const html = viewer("tiny.gcode", model).html;
    expect(html).toContain('id="layerSlider" aria-label="Layer / Z"');
    expect(html).toContain("Move in layer");
    expect(html).toContain('id="moveSlider"');
  });

  it("packs valid geometry into syntactically valid sandbox script", () => {
    const html = viewer("</script><b>unsafe</b>", parse(fixture())).html;
    const data = packed(html);
    expect(Buffer.from(data.p, "base64").byteLength).toBe(Buffer.from(data.k, "base64").byteLength * 10);
    expect(data.layers).toHaveLength(2);
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(() => new Function(script!)).not.toThrow();
    expect(html).not.toContain("</script><b>unsafe</b>");
  });

  it("classifies travel, perimeter, external perimeter, and infill and shows styled infill by default", () => {
    const model = parse(fixture());
    expect(new Set(model.segments.map((segment) => segment[5]))).toEqual(new Set([0, 1, 2, 3]));
    const html = viewer("features.gcode", model).html;
    expect(html).toContain('id="infill" type="checkbox" checked');
    expect(html).toContain("#b184ff");
    expect(html).toContain("kind===3?.65");
  });

  it("retains straight rectilinear source segments instead of making cross-run chords", () => {
    const source = parse(manyInfill("rectilinear", 20_100));
    const infill = source.segments.filter((segment) => segment[5] === 3);
    expect(infill).toHaveLength(20_000);
    // Every retained segment is one original grid step; coalescing would create long chords.
    expect(Math.max(...infill.map((s) => Math.hypot(s[2] - s[0], s[3] - s[1])))).toBeLessThan(200);
    expect(infill.every((s) => Number.isInteger(s[0]) && Number.isInteger(s[1]) && Number.isInteger(s[2]) && Number.isInteger(s[3]))).toBe(true);
  });

  it("uses gyroid metadata to reduce a run into coherent connected curve sections", () => {
    const model = parse(manyInfill("gyroid", 20_100));
    const infill = model.segments.filter((segment) => segment[5] === 3);
    expect(model.fillPattern).toBe("gyroid");
    expect(infill).toHaveLength(20_000);
    expect(infill.some((s) => Math.hypot(s[2] - s[0], s[3] - s[1]) > 1.5)).toBe(true);
    for (let i = 1; i < infill.length; i++) {
      expect(infill[i][0]).toBe(infill[i - 1][2]);
      expect(infill[i][1]).toBe(infill[i - 1][3]);
    }
  });

  it("bounds retained segments and packed HTML", () => {
    const model = parse(manyInfill("rectilinear", 70_000));
    expect(model.segments.length).toBeLessThanOrEqual(MAX_SEGMENTS);
    const html = viewer("bounded.gcode", model).html;
    expect(Buffer.byteLength(html)).toBeLessThan(1_000_000);
    expect(Buffer.from(packed(html).k, "base64").byteLength).toBe(model.segments.length);
  });
});

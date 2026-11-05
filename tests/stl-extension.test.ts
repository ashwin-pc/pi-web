import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { stlContribution, stlRenderGeometry, stlTransparentOrder } from "../examples/pi-web-extensions/3d-modeling/stl.js";

import { stlEnvironment, stlFloorFactor } from "../examples/pi-web-extensions/3d-modeling/stl-environment.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

describe("STL CAD rendering", () => {
  it("derives a finite world-space environment with exactly twelve bounds edges", () => {
    const b=[-2,-4,-6,2,4,6], env=stlEnvironment(b);
    expect(env.floorY).toBeLessThan(b[1]);
    expect(env.box.length).toBe(72);
    const edges=new Set<string>();
    for(let i=0;i<env.box.length;i+=6){
      const a=env.box.slice(i,i+3),c=env.box.slice(i+3,i+6);
      expect(a.filter((v,k)=>v!==c[k])).toHaveLength(1);
      for(const v of [a,c])v.forEach((n,k)=>expect([b[k],b[k+3]]).toContain(n));
      edges.add([a.join(),c.join()].sort().join("/"));
    }
    expect(edges.size).toBe(12);
    for(const key of ["ground","grid","shadow"] as const){
      expect(env[key].every(Number.isFinite)).toBe(true);
      expect(env[key].length/3).toBe(env[`${key}Alpha`].length);
    }
    const fn=vm.runInNewContext(`(${stlEnvironment.toString()})`);
    expect(fn(b).box.length).toBe(72);
  });
  it("fades before the orthographic horizon, hiding all below-floor views at every zoom", () => {
    expect(stlFloorFactor(-1)).toBe(1);
    expect(stlFloorFactor(-.11)).toBeCloseTo(.5);
    expect(stlFloorFactor(0)).toBe(0);
    expect(stlFloorFactor(.8)).toBe(0);
    const fn=vm.runInNewContext(`(${stlFloorFactor.toString()})`);
    expect(fn(-.11)).toBeCloseTo(.5);
  });
  const p = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0, 1,0,1]);
  it("omits coplanar diagonals and keeps boundary edges", () => {
    const g = stlRenderGeometry(p, new Float32Array(p.length), new Uint16Array([0,1,2, 0,2,3]));
    expect(g.lines.length / 6).toBe(4);
    expect(Array.from(g.normals)).toEqual([0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1]);
  });
  it("preserves a right-angle crease with separate corner normals and one feature edge", () => {
    const g = stlRenderGeometry(p, new Float32Array(p.length), new Uint32Array([0,1,2, 1,4,2]));
    expect(g.lines.length / 6).toBe(5);
    expect(Array.from(g.normals.slice(3,6))).toEqual([0,0,1]);
    expect(Array.from(g.normals.slice(9,12))).toEqual([-1,0,0]);
  });
  it("smooths shallow neighboring facets without creating outlines", () => {
    const points = new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,-1,.1]);
    const g = stlRenderGeometry(points, new Float32Array(points.length), new Uint16Array([0,1,2, 1,0,3]));
    expect(g.lines.length / 6).toBe(4);
    expect(g.normals[1]).toBeGreaterThan(0);
    expect(Array.from(g.normals.slice(0,3))).toEqual(Array.from(g.normals.slice(12,15)));
  });
  it("sorts transparency back-to-front for both camera directions with stable coplanar order", () => {
    const positions = new Float32Array([0,0,-1, 1,0,-1, 0,1,-1, 0,0,1, 1,0,1, 0,1,1]);
    expect(Array.from(stlTransparentOrder(positions, [0,0,1]))).toEqual([3,4,5,0,1,2]);
    expect(Array.from(stlTransparentOrder(positions, [0,0,-1]))).toEqual([0,1,2,3,4,5]);
    expect(Array.from(stlTransparentOrder(positions, [0,1,0]))).toEqual([0,1,2,3,4,5]);
    const fn = vm.runInNewContext(`(${stlTransparentOrder.toString()})`);
    expect(Array.from(fn(positions, [0,0,1]))).toEqual([3,4,5,0,1,2]);
  });
  it("budgets the complete UTF-8 document for a dense mesh", async () => {
    const root=await mkdtemp(path.join(tmpdir(), "stl-budget-"));roots.push(root);
    await mkdir(path.join(root,".pi/web/artifacts"),{recursive:true});
    let seed=17;
    const coordinate=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296*100;};
    const facets=Array.from({length:14000},()=>Array.from({length:3},()=>`vertex ${coordinate()} ${coordinate()} ${coordinate()}`).join("\n")).join("\n");
    await writeFile(path.join(root,".pi/web/artifacts/dense.stl"),`solid dense\n${facets}\nendsolid`);
    const {html}=await stlContribution(()=>root).render({context:{name:"密集.stl",path:"/api/artifacts/dense.stl"}});
    expect(html).toContain('aria-label="Interactive 3D STL model"');
    expect(Buffer.byteLength(html,"utf8")).toBeLessThanOrEqual(990000);
    expect(()=>new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)![1])).not.toThrow();
  });
  it("embeds a standalone helper, accessible independent controls and a bounded single mesh payload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stl-preview-")); roots.push(root);
    await mkdir(path.join(root, ".pi/web/artifacts"), { recursive: true });
    await writeFile(path.join(root, ".pi/web/artifacts/test.stl"), "solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid");
    const { html } = await stlContribution(() => root).render({ context: { name: "test.stl", path: "/api/artifacts/test.stl" } });
    expect(html).toContain('<option value="cad">CAD</option>');
    expect(html).toContain('id="outlines" type="checkbox" checked');
    expect(html).toContain('aria-label="Surface opacity"');
    expect(html).toContain('aria-label="Shading style"');
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
    const compactCss = css.replace(/\s+/g, "").replaceAll(";}", "}");
    expect(compactCss).toContain("--accent:#c5a679");
    expect(compactCss).toContain("background:radial-gradient(ellipseat50%40%,#373735,#20201f65%,#171716)");
    expect(css.match(/@media/g)).toHaveLength(1);
    expect(css).not.toMatch(/\.stage::|\.hint/);
    expect(html).not.toContain('class="hint"');
    expect(compactCss).toContain('.controlsinput{accent-color:var(--accent)}');
    expect(html).toContain('vec3 base=vec3(.68);');
    expect(html).not.toMatch(/#080d18|#24334d|#90cfff|vec3\(\.10,\.64,\.82\)/);
    expect(html).toContain('checked aria-label="Feature outlines"');
    expect(compactCss).toContain('@media(max-width:520px)');
    expect(compactCss).toContain('display:flex;flex-wrap:nowrap;align-items:center');
    expect(html).toContain('aria-expanded="false" aria-controls="model-info"');
    expect(html).toContain('<p class="navigation-help">Drag to orbit · two-finger drag to pan · pinch to zoom.');
    expect(compactCss).toContain('.controls.control-name,.controls.feature-prefix{display:none}');
    expect(compactCss).toContain('.controlsinput[type=range]{flex:1;min-width:24px;');
    expect(html).not.toMatch(/localStorage|sessionStorage|https?:\/\//);
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(990_000);
    expect((html.match(/const M =/g) || []).length).toBe(1);
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
    expect(() => new vm.Script(script)).not.toThrow();
    const helper = script.match(/const geometry = ([\s\S]*?)\(P, N, I\)/)![1];
    const fn = vm.runInNewContext(`(${helper})`);
    expect(fn(p, new Float32Array(p.length), new Uint16Array([0,1,2])).lines.length).toBe(18);
    const compact = html.replace(/\s+/g, "").replaceAll('"', "'");
    expect(html).toContain("gl.POLYGON_OFFSET_FILL");
    expect(compact).toContain("gl.colorMask(false,false,false,false)");
    // A single open triangle has six line vertices but only three surface
    // normals: the edge pass must not fetch the short surface-normal buffer.
    expect(compact).toContain("gl.disableVertexAttribArray(gl.getAttribLocation(pr,'n'))");
    expect(compact).toContain("gl.vertexAttrib3f(gl.getAttribLocation(pr,'n'),0,0,1)");
    expect(compact).toContain("if(alpha<1){gl.disable(gl.DEPTH_TEST)");
    expect(compactCss).toContain(".controls{left:50%;bottom:22px;transform:translateX(-50%)");
    expect(html).toContain('id="bounds" type="checkbox" checked aria-label="Bounding box"');
    expect(script).toContain("environment(floorFactor(X))");
    expect(script).toContain("environment(0, true)");
    expect(script).toContain("else if (factor > 0)");
    expect(script).toContain("gl.depthMask(false)");
    expect(script).not.toMatch(/depthMask\(true\)[^}]*paint\(ground/);
    expect(script).toContain("[style, outlines, opacity, boundsToggle]");
  });
});

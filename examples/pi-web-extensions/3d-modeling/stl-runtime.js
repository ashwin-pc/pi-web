const M = __MODEL__,
  c = document.querySelector("canvas"),
  gl = c.getContext("webgl2", { antialias: true }),
  info = document.querySelector(".info");
if (!gl) throw Error("WebGL 2 is required");
function bytes(s) {
  const q = atob(s),
    a = new Uint8Array(q.length);
  for (let i = 0; i < q.length; i++) a[i] = q.charCodeAt(i);
  return a.buffer;
}
const P = new Float32Array(bytes(M.p)),
  N = new Float32Array(bytes(M.n)),
  I = M.u === 16 ? new Uint16Array(bytes(M.i)) : new Uint32Array(bytes(M.i));
const geometry = __GEOMETRY__(P, N, I),
  style = document.querySelector("#style"),
  outlines = document.querySelector("#outlines"),
  opacity = document.querySelector("#opacity");
const transparentOrder = __ORDER__;
let sortedCamera = "";
const orderBuffer = gl.createBuffer();
function sh(t, s) {
  const x = gl.createShader(t);
  gl.shaderSource(x, s);
  gl.compileShader(x);
  if (!gl.getShaderParameter(x, gl.COMPILE_STATUS))
    throw Error(gl.getShaderInfoLog(x));
  return x;
}
const pr = gl.createProgram();
gl.attachShader(
  pr,
  sh(
    gl.VERTEX_SHADER,
    "#version 300 es\nin vec3 p,n;uniform mat3 r;uniform vec3 center;uniform float scale,aspect;uniform vec2 pan;out vec3 normal;void main(){vec3 q=r*(p-center)*scale;gl_Position=vec4(q.x/aspect+pan.x,q.y+pan.y,q.z*.45,1);normal=r*n;}",
  ),
);
gl.attachShader(
  pr,
  sh(
    gl.FRAGMENT_SHADER,
    "#version 300 es\nprecision mediump float;in vec3 normal;uniform bool line;uniform float alpha;out vec4 color;void main(){if(line){color=vec4(.015,.015,.015,1);return;}float d=abs(dot(normalize(normal),normalize(vec3(.35,.55,.8))));vec3 base=vec3(.68);color=vec4(base*(.58+.42*d),alpha);}",
  ),
);
gl.linkProgram(pr);
gl.useProgram(pr);
function buffer(a) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
  return b;
}
const pb = buffer(geometry.positions),
  nb = buffer(geometry.normals),
  sb = buffer(geometry.smoothNormals),
  eb = buffer(geometry.lines),
  flat = new Float32Array(geometry.normals.length);
for (let i = 0; i < flat.length; i += 9) {
  const a = geometry.positions;
  const ux = a[i + 3] - a[i],
    uy = a[i + 4] - a[i + 1],
    uz = a[i + 5] - a[i + 2],
    vx = a[i + 6] - a[i],
    vy = a[i + 7] - a[i + 1],
    vz = a[i + 8] - a[i + 2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  for (let j = 0; j < 9; j++) flat[i + j] = n[j % 3];
}
const fb = buffer(flat);
function attribute(key, b) {
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  const l = gl.getAttribLocation(pr, key);
  gl.enableVertexAttribArray(l);
  gl.vertexAttribPointer(l, 3, gl.FLOAT, false, 0, 0);
}
const B = M.b,
  center = new Float32Array([
    (B[0] + B[3]) / 2,
    (B[1] + B[4]) / 2,
    (B[2] + B[5]) / 2,
  ]),
  span = Math.max(B[3] - B[0], B[4] - B[1], B[5] - B[2]) || 1;
// Environment uses the same orthographic camera as the model: no finite-eye
// plane-side approximation or perspective singularities at extreme zoom.
const environmentGeometry = __ENVIRONMENT__(B);
const floorFactor = __FLOOR_FACTOR__;
const boundsToggle = document.querySelector("#bounds");
const envProgram = gl.createProgram();
gl.attachShader(
  envProgram,
  sh(
    gl.VERTEX_SHADER,
    `#version 300 es
in vec3 p;in float a;uniform mat3 r;uniform vec3 center;uniform float scale,aspect;uniform vec2 pan;out float fade;
void main(){vec3 q=r*(p-center)*scale;gl_Position=vec4(q.x/aspect+pan.x,q.y+pan.y,q.z*.45,1);fade=a;}`,
  ),
);
gl.attachShader(
  envProgram,
  sh(
    gl.FRAGMENT_SHADER,
    `#version 300 es
precision mediump float;uniform vec4 ink;in float fade;out vec4 color;
void main(){color=vec4(ink.rgb,ink.a*fade);}`,
  ),
);
gl.linkProgram(envProgram);
function layer(p, a) {
  return {
    p: buffer(new Float32Array(p)),
    a: buffer(new Float32Array(a || Array(p.length / 3).fill(1))),
    count: p.length / 3,
  };
}
const ground = layer(
    environmentGeometry.ground,
    environmentGeometry.groundAlpha,
  ),
  grid = layer(environmentGeometry.grid, environmentGeometry.gridAlpha),
  shadow = layer(environmentGeometry.shadow, environmentGeometry.shadowAlpha),
  box = layer(environmentGeometry.box);
const hud = document.createElement("div");
hud.className = "axis-hud";
hud.setAttribute("aria-label", "Orbit-linked XYZ orientation");
document.querySelector(".stage").append(hud);
function environment(factor, drawBox = false) {
  gl.useProgram(envProgram);
  for (const key of ["r", "center", "scale", "aspect", "pan"]) {
    const value = gl.getUniform(pr, gl.getUniformLocation(pr, key)),
      loc = gl.getUniformLocation(envProgram, key);
    if (key === "r") gl.uniformMatrix3fv(loc, false, value);
    else if (key === "center") gl.uniform3fv(loc, value);
    else if (key === "pan") gl.uniform2fv(loc, value);
    else gl.uniform1f(loc, value);
  }
  function paint(mesh, ink, primitive) {
    for (const [key, b, size] of [
      ["p", mesh.p, 3],
      ["a", mesh.a, 1],
    ]) {
      const loc = gl.getAttribLocation(envProgram, key);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    gl.uniform4fv(gl.getUniformLocation(envProgram, "ink"), ink);
    gl.drawArrays(primitive, 0, mesh.count);
  }
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  // The entire floor is a composited backdrop, NEVER an occluder.
  gl.depthMask(false);
  if (drawBox) {
    if (boundsToggle.checked) paint(box, [0.76, 0.69, 0.55, 0.2], gl.LINES);
  } else if (factor > 0) {
    paint(ground, [0.13, 0.13, 0.125, 0.94 * factor], gl.TRIANGLES);
    paint(grid, [0.62, 0.62, 0.59, 0.27 * factor], gl.LINES);
    paint(shadow, [0, 0, 0, 0.47 * factor], gl.TRIANGLES);
  }
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  gl.useProgram(pr);
}
function orientation(r) {
  hud.innerHTML =
    '<svg width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="2" fill="#b9b3a5"/>' +
    [0, 1, 2]
      .map((a) => {
        const x = 40 + r[a * 3] * 25,
          y = 40 - r[a * 3 + 1] * 25;
        return (
          '<line x1="40" y1="40" x2="' +
          x +
          '" y2="' +
          y +
          '" stroke="' +
          ["#c4ab80", "#b6b6af", "#777871"][a] +
          '" stroke-width="1.2"/><text x="' +
          (40 + r[a * 3] * 34) +
          '" y="' +
          (43 - r[a * 3 + 1] * 34) +
          '" fill="#a9a69d" text-anchor="middle" font-family="system-ui" font-size="8">' +
          ["X", "Y", "Z"][a] +
          "</text>"
        );
      })
      .join("") +
    "</svg>";
}
gl.uniform3fv(gl.getUniformLocation(pr, "center"), center);
gl.enable(gl.DEPTH_TEST);
/* STL winding is not reliably consistent; render both sides. */ let ax = -0.58,
  ay = 2.4,
  z = 1,
  ox = 0,
  oy = 0,
  pts = new Map(),
  gesture,
  mode = "orbit";
function draw() {
  const d = devicePixelRatio || 1,
    w = c.clientWidth,
    h = c.clientHeight;
  c.width = w * d;
  c.height = h * d;
  gl.viewport(0, 0, c.width, c.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const x = Math.cos(ax),
    X = Math.sin(ax),
    y = Math.cos(ay),
    Y = Math.sin(ay);
  gl.uniformMatrix3fv(
    gl.getUniformLocation(pr, "r"),
    false,
    new Float32Array([y, X * Y, -x * Y, 0, x, X, Y, -X * y, x * y]),
  );
  gl.uniform1f(gl.getUniformLocation(pr, "scale"), (1.55 * z) / span);
  gl.uniform1f(gl.getUniformLocation(pr, "aspect"), w / h);
  gl.uniform2f(gl.getUniformLocation(pr, "pan"), (ox / w) * 2, (-oy / h) * 2);
  environment(floorFactor(X));
  orientation(gl.getUniform(pr, gl.getUniformLocation(pr, "r")));
  const alpha = Number(opacity.value);
  gl.uniform1i(gl.getUniformLocation(pr, "line"), 0);
  gl.uniform1f(gl.getUniformLocation(pr, "alpha"), alpha);
  attribute("p", pb);
  attribute(
    "n",
    style.value === "smooth" ? sb : style.value === "flat" ? fb : nb,
  );
  /* Nearest-surface depth is retained for visible feature edges only. */ gl.disable(
    gl.BLEND,
  );
  gl.depthMask(true);
  gl.colorMask(false, false, false, false);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(1, 1);
  gl.depthFunc(gl.LESS);
  gl.drawArrays(gl.TRIANGLES, 0, I.length);
  gl.colorMask(true, true, true, true);
  gl.depthMask(false);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  if (alpha < 1) {
    gl.disable(gl.DEPTH_TEST);
    const key = ax + "," + ay;
    if (sortedCamera !== key) {
      const order = transparentOrder(geometry.positions, [-x * Y, X, x * y]);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, orderBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, order, gl.DYNAMIC_DRAW);
      sortedCamera = key;
    } else gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, orderBuffer);
    gl.drawElements(gl.TRIANGLES, I.length, gl.UNSIGNED_INT, 0);
    gl.enable(gl.DEPTH_TEST);
  } else gl.drawArrays(gl.TRIANGLES, 0, I.length);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  if (outlines.checked) {
    gl.uniform1i(gl.getUniformLocation(pr, "line"), 1);
    gl.disableVertexAttribArray(gl.getAttribLocation(pr, "n"));
    gl.vertexAttrib3f(gl.getAttribLocation(pr, "n"), 0, 0, 1);
    attribute("p", eb);
    gl.drawArrays(gl.LINES, 0, geometry.lines.length / 3);
  }
  environment(0, true);
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  gl.depthFunc(gl.LESS);
}
function pair() {
  const a = [...pts.values()];
  return a.length < 2
    ? null
    : {
        x: (a[0].x + a[1].x) / 2,
        y: (a[0].y + a[1].y) / 2,
        d: Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y),
      };
}
c.oncontextmenu = (e) => e.preventDefault();
c.onpointerdown = (e) => {
  e.preventDefault();
  c.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  mode =
    e.pointerType === "mouse" && (e.button || e.shiftKey) ? "pan" : "orbit";
  gesture = pair();
};
c.onpointermove = (e) => {
  if (!pts.has(e.pointerId)) return;
  const old = pts.get(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size > 1) {
    const q = pair();
    if (gesture) {
      z = Math.max(0.15, Math.min(10, (z * q.d) / (gesture.d || q.d)));
      ox += q.x - gesture.x;
      oy += q.y - gesture.y;
    }
    gesture = q;
  } else if (mode === "pan") {
    ox += e.clientX - old.x;
    oy += e.clientY - old.y;
  } else {
    ay += (e.clientX - old.x) * 0.009;
    ax += (e.clientY - old.y) * 0.009;
  }
  draw();
};
function up(e) {
  pts.delete(e.pointerId);
  gesture = pair();
}
c.onpointerup = c.onpointercancel = up;
c.onwheel = (e) => {
  e.preventDefault();
  z = Math.max(0.15, Math.min(10, z * Math.exp(-e.deltaY * 0.001)));
  draw();
};
for (const control of [style, outlines, opacity, boundsToggle])
  control.oninput = () => {
    document.querySelector("#alpha").textContent =
      Math.round(Number(opacity.value) * 100) + "%";
    draw();
  };
const button = document.querySelector("#info");
button.onclick = () => {
  const open = info.classList.toggle("open");
  button.setAttribute("aria-expanded", String(open));
};
document.querySelector("#reset").onclick = () => {
  ax = -0.58;
  ay = 2.4;
  z = 1;
  ox = oy = 0;
  draw();
};
new ResizeObserver(draw).observe(c);
draw();

function initializeStlRenderer() {
  const canvas = document.querySelector("canvas"),
    status = document.querySelector("#status");
  const gl = canvas.getContext("webgl2", { antialias: true });
  let port,
    ended = false;
  const buffers = [],
    edgeBuffers = [];
  const edgeToggle = document.querySelector("#outlines"),
    edgeStatus = document.querySelector("#edge-status");
  let edgePort,
    edgeReady = false,
    edgeLoading = false;
  const clearEdges = () => {
    for (const entry of edgeBuffers) gl.deleteBuffer(entry.buffer);
    edgeBuffers.length = 0;
    edgeReady = false;
    edgePort?.close();
    edgePort = null;
  };
  const edgeFailure = (message) => {
    clearEdges();
    edgeLoading = false;
    edgeToggle.checked = false;
    edgeToggle.setAttribute("aria-busy", "false");
    edgeStatus.textContent = message;
    render();
  };
  let failed = false,
    scheduled = false;
  const error = (e) => {
    if (failed) return;
    failed = true;
    clearEdges();
    port?.postMessage({ type: "derive-cancel" });
    status.textContent = e.message || String(e);
    document.querySelector("#waiting").hidden = true;
    for (const entry of buffers) gl.deleteBuffer(entry.buffer);
    buffers.length = 0;
    for (const mesh of [box, ground, grid, shadow])
      if (mesh) {
        gl.deleteBuffer(mesh.p);
        gl.deleteBuffer(mesh.a);
      }
    box = ground = grid = shadow = null;
    port?.postMessage({ type: "error", error: status.textContent });
  };
  if (!gl) {
    window.addEventListener("message", (event) => {
      if (
        event.source === parent &&
        event.data?.type === "pi-artifact-stream" &&
        event.ports.length === 1
      )
        event.ports[0].postMessage({
          type: "error",
          error:
            "WebGL 2 is unavailable. Enable browser hardware acceleration or download the original for a desktop viewer.",
        });
    });
    return;
  }
  const shader = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw Error(gl.getShaderInfoLog(s));
    return s;
  };
  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(
      program,
      shader(
        gl.VERTEX_SHADER,
        `#version 300 es
in vec3 p, n;
uniform mat3 r;
uniform vec3 center;
uniform float scale, aspect;
uniform vec2 pan;
out vec3 normal;

void main() {
  vec3 q = r * (p - center) * scale;
  gl_Position = vec4(q.x / aspect + pan.x, q.y + pan.y, q.z * .45, 1);
  normal = r * n;
}`,
      ),
    );
    gl.attachShader(
      program,
      shader(
        gl.FRAGMENT_SHADER,
        `#version 300 es
precision mediump float;
in vec3 normal;
uniform bool line;
uniform float alpha;
out vec4 color;

void main() {
  if (line) {
    color = vec4(.015, .015, .015, 1);
    return;
  }
  float d = abs(dot(normalize(normal), normalize(vec3(.35, .55, .8))));
  vec3 base = vec3(.68);
  color = vec4(base * (.58 + .42 * d), alpha);
}`,
      ),
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
  } catch (_) {
    window.addEventListener("message", (event) => {
      if (
        event.source === parent &&
        event.data?.type === "pi-artifact-stream" &&
        event.ports.length === 1
      )
        event.ports[0].postMessage({
          type: "error",
          error:
            "The graphics renderer could not initialize. Update your browser or graphics driver, or download the original for a desktop viewer.",
        });
    });
    return;
  }
  const p = gl.getAttribLocation(program, "p"),
    n = gl.getAttribLocation(program, "n");
  const uniforms = Object.fromEntries(
    ["r", "center", "scale", "aspect", "pan", "line", "alpha"].map((k) => [
      k,
      gl.getUniformLocation(program, k),
    ]),
  );
  const bounds = [
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity,
  ];
  let batch = new Float32Array(8192 * 18),
    used = 0;
  let sourceDecoder,
    size = 0;
  let decodeMs = 0,
    uploadMs = 0;
  const upload = () => {
    if (!used) return;
    const uploadStart = performance.now();
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, batch.subarray(0, used), gl.STATIC_DRAW);
    const failure = gl.getError();
    if (failure !== gl.NO_ERROR)
      throw Error(
        "GPU memory allocation failed; close the model or use a larger-memory device.",
      );
    buffers.push({ buffer, count: used / 6 });
    used = 0;
    uploadMs += performance.now() - uploadStart;
  };
  // Scalar binary path: no vertex/normal arrays or spread calls per triangle.
  const triangle = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    if (
      !Number.isFinite(ax) ||
      !Number.isFinite(ay) ||
      !Number.isFinite(az) ||
      !Number.isFinite(bx) ||
      !Number.isFinite(by) ||
      !Number.isFinite(bz) ||
      !Number.isFinite(cx) ||
      !Number.isFinite(cy) ||
      !Number.isFinite(cz)
    )
      throw Error(
        "STL contains non-finite vertex coordinates; no triangles were silently removed.",
      );
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az,
      vx = cx - ax,
      vy = cy - ay,
      vz = cz - az;
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    // Preserve the original flat shader input: unnormalised face cross product.
    bounds[0] = Math.min(bounds[0], ax, bx, cx);
    bounds[1] = Math.min(bounds[1], ay, by, cy);
    bounds[2] = Math.min(bounds[2], az, bz, cz);
    bounds[3] = Math.max(bounds[3], ax, bx, cx);
    bounds[4] = Math.max(bounds[4], ay, by, cy);
    bounds[5] = Math.max(bounds[5], az, bz, cz);
    batch[used++] = ax;
    batch[used++] = ay;
    batch[used++] = az;
    batch[used++] = nx;
    batch[used++] = ny;
    batch[used++] = nz;
    batch[used++] = bx;
    batch[used++] = by;
    batch[used++] = bz;
    batch[used++] = nx;
    batch[used++] = ny;
    batch[used++] = nz;
    batch[used++] = cx;
    batch[used++] = cy;
    batch[used++] = cz;
    batch[used++] = nx;
    batch[used++] = ny;
    batch[used++] = nz;
    if (used === batch.length) upload();
  };
  function environmentBuffer(a) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
    return b;
  }
  let environmentGeometry, environmentCamera;
  const viewingBounds = __VIEWING_BOUNDS__,
    viewingRotation = __VIEWING_ROTATION__;
  const isZUp = () => document.querySelector("#up-axis").value === "z";
  const floorFactor = __FLOOR_FACTOR__;
  const boundsToggle = document.querySelector("#bounds");
  const envProgram = gl.createProgram();
  gl.attachShader(
    envProgram,
    shader(
      gl.VERTEX_SHADER,
      `#version 300 es
in vec3 p;in float a;uniform mat3 r;uniform vec3 center;uniform float scale,aspect;uniform vec2 pan;out float fade;
void main(){vec3 q=r*(p-center)*scale;gl_Position=vec4(q.x/aspect+pan.x,q.y+pan.y,q.z*.45,1);fade=a;}`,
    ),
  );
  gl.attachShader(
    envProgram,
    shader(
      gl.FRAGMENT_SHADER,
      `#version 300 es
precision mediump float;uniform vec4 ink;in float fade;out vec4 color;
void main(){color=vec4(ink.rgb,ink.a*fade);}`,
    ),
  );
  gl.linkProgram(envProgram);
  function layer(p, a) {
    return {
      p: environmentBuffer(new Float32Array(p)),
      a: environmentBuffer(new Float32Array(a || Array(p.length / 3).fill(1))),
      count: p.length / 3,
    };
  }
  let ground, grid, shadow, box;
  const makeFloor = () => {
    for (const mesh of [ground, grid, shadow, box])
      if (mesh) {
        gl.deleteBuffer(mesh.p);
        gl.deleteBuffer(mesh.a);
      }
    environmentGeometry = __ENVIRONMENT__(viewingBounds(bounds, isZUp()));
    ground = layer(environmentGeometry.ground, environmentGeometry.groundAlpha);
    grid = layer(environmentGeometry.grid, environmentGeometry.gridAlpha);
    shadow = layer(environmentGeometry.shadow, environmentGeometry.shadowAlpha);
    box = layer(environmentGeometry.box);
  };
  function environment(factor, drawBox = false) {
    gl.useProgram(envProgram);
    for (const key of ["r", "center", "scale", "aspect", "pan"]) {
      const value =
          key === "r"
            ? environmentCamera.r
            : key === "center"
              ? environmentCamera.center
              : gl.getUniform(program, gl.getUniformLocation(program, key)),
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
    } else if (factor > 0 && document.querySelector("#ground").checked) {
      paint(ground, [0.13, 0.13, 0.125, 0.94 * factor], gl.TRIANGLES);
      if (document.querySelector("#grid").checked)
        paint(grid, [0.62, 0.62, 0.59, 0.27 * factor], gl.LINES);
      paint(shadow, [0, 0, 0, 0.47 * factor], gl.TRIANGLES);
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.useProgram(program);
  }

  const draw = () => {
    scheduled = false;
    if (!ended || failed) return;
    const { angle, pan, zoom } = camera.snapshot();
    const d = devicePixelRatio || 1,
      w = canvas.clientWidth,
      h = canvas.clientHeight;
    canvas.width = w * d;
    canvas.height = h * d;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(program);
    const x = Math.cos(angle[0]),
      X = Math.sin(angle[0]),
      y = Math.cos(angle[1]),
      Y = Math.sin(angle[1]);
    const r = [y, X * Y, -x * Y, 0, x, X, Y, -X * y, x * y],
      b = viewingBounds(bounds, isZUp());
    environmentCamera = {
      r: new Float32Array(r),
      center: new Float32Array([0, 1, 2].map((k) => (b[k] + b[k + 3]) / 2)),
    };
    gl.uniformMatrix3fv(
      uniforms.r,
      false,
      new Float32Array(viewingRotation(r, isZUp())),
    );
    gl.uniform3f(
      uniforms.center,
      ...[0, 1, 2].map((k) => (bounds[k] + bounds[k + 3]) / 2),
    );
    // A viewport-aware bounding sphere keeps the complete source box in frame
    // at default zoom, including portrait panels, without changing fit on orbit.
    const diameter =
      Math.hypot(
        bounds[3] - bounds[0],
        bounds[4] - bounds[1],
        bounds[5] - bounds[2],
      ) || 1;
    gl.uniform1f(uniforms.scale, (1.55 * zoom * Math.min(1, w / h)) / diameter);
    gl.uniform1f(uniforms.aspect, w / h);
    gl.uniform2fv(uniforms.pan, pan);
    environment(floorFactor(X));
    gl.uniform1i(uniforms.line, 0);
    gl.uniform1f(uniforms.alpha, 1);
    gl.enableVertexAttribArray(p);
    gl.enableVertexAttribArray(n);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    const meshPass = () => {
      for (const entry of buffers) {
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
        gl.vertexAttribPointer(p, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(n, 3, gl.FLOAT, false, 24, 12);
        gl.drawArrays(gl.TRIANGLES, 0, entry.count);
      }
    };
    gl.colorMask(false, false, false, false);
    meshPass();
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    meshPass();
    gl.disable(gl.POLYGON_OFFSET_FILL);
    environment(0, true);
    gl.disable(gl.BLEND);
    if (edgeReady && edgeToggle.checked) {
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.uniform1i(uniforms.line, 1);
      gl.enableVertexAttribArray(p);
      gl.disableVertexAttribArray(n);
      gl.vertexAttrib3f(n, 0, 0, 1);
      for (const entry of edgeBuffers) {
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
        gl.vertexAttribPointer(p, 3, gl.FLOAT, false, 12, 0);
        gl.drawArrays(gl.LINES, 0, entry.count);
      }
    }
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  };
  const render = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(draw);
    }
  };
  const camera = createStlCamera(canvas, render);
  listenForStlSource({
    onOpen(sourcePort, sourceSize) {
      port = sourcePort;
      size = sourceSize;
      sourceDecoder = createStlDecoder({
        size,
        onTriangle: triangle,
        onProgress(count, bytes) {
          status.textContent = `${count.toLocaleString()} triangles decoded · ${((bytes / size) * 100).toFixed(0)}% received`;
        },
      });
    },
    isFailed: () => failed,
    onError: error,
    onDeriveError: edgeFailure,
    onDeriveStatus() {
      edgeStatus.textContent =
        "Generating true feature edges… The model remains usable. Uncheck to cancel.";
    },
    onChunk(data) {
      const before = performance.now(),
        previousUpload = uploadMs;
      sourceDecoder.consume(data);
      decodeMs += performance.now() - before - (uploadMs - previousUpload);
      if (gl.isContextLost())
        throw Error(
          "The graphics context was lost. Open again to restart loading.",
        );
      return { triangles: sourceDecoder.count, decodeMs, uploadMs };
    },
    onEnd() {
      const before = performance.now();
      sourceDecoder.finish();
      decodeMs += performance.now() - before;
      upload();
      batch = null;
      ended = true;
      const dimensions = [0, 1, 2]
        .map((k) => (bounds[k + 3] - bounds[k]).toFixed(2))
        .join(" × ");
      status.textContent = `Full detail · ${sourceDecoder.count.toLocaleString()} triangles`;
      document.querySelector("#info-count").textContent =
        `${sourceDecoder.count.toLocaleString()} source triangles · 100% retained`;
      document.querySelector("#dimensions").textContent =
        `${dimensions} model units`;
      document.querySelector("#source-size").textContent =
        `${(size / 1048576).toFixed(1)} MiB source · face normals`;
      document.querySelector("#waiting").hidden = true;
      makeFloor();
      camera.fit();
      render();
      return { triangles: sourceDecoder.count, decodeMs, uploadMs };
    },
  });
  window.addEventListener("message", (event) => {
    if (
      event.source !== parent ||
      event.data?.type !== "pi-artifact-derived" ||
      event.ports.length !== 1
    )
      return;
    const incoming = event.ports[0];
    if (!ended || !edgeLoading || !edgeToggle.checked || edgePort) {
      incoming.close();
      return;
    }
    const size = event.data.size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size % 24 ||
      size > 128 * 1048576
    ) {
      incoming.postMessage({
        type: "error",
        error: "Invalid feature edge resource.",
      });
      edgeFailure("Invalid feature edge resource.");
      return;
    }
    edgePort = incoming;
    receiveStlEdges({
      port: incoming,
      size,
      onBatch(data) {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        if (gl.getError() !== gl.NO_ERROR) {
          gl.deleteBuffer(buffer);
          throw Error(
            "Feature edge GPU allocation failed; the full mesh remains available.",
          );
        }
        edgeBuffers.push({ buffer, count: data.length / 3 });
      },
      onComplete(lines) {
        edgeReady = true;
        edgeLoading = false;
        edgeToggle.setAttribute("aria-busy", "false");
        edgeStatus.textContent = `${lines.toLocaleString()} true feature edges · 35° source-face crease threshold`;
        edgePort = null;
        render();
      },
      onError: edgeFailure,
    });
  });

  edgeToggle.onchange = () => {
    if (!ended) {
      edgeToggle.checked = false;
      edgeStatus.textContent = "Load the complete mesh first.";
      return;
    }
    if (!edgeToggle.checked) {
      if (edgeLoading) {
        port?.postMessage({ type: "derive-cancel" });
        clearEdges();
        edgeLoading = false;
        edgeToggle.setAttribute("aria-busy", "false");
        edgeStatus.textContent = "Feature edge generation cancelled.";
      }
      render();
      return;
    }
    if (edgeReady) {
      render();
      return;
    }
    edgeLoading = true;
    edgeToggle.setAttribute("aria-busy", "true");
    edgeStatus.textContent =
      "Generating true feature edges… The model remains usable. Uncheck to cancel.";
    port?.postMessage({ type: "derive" });
  };
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    error(
      Error(
        "GPU context lost. Try opening the preview again, or download the original.",
      ),
    );
  });
  document.querySelector("#up-axis").onchange = () => {
    if (ended) {
      makeFloor();
      render();
    }
  };
  for (const control of ["#bounds", "#ground", "#grid"])
    document.querySelector(control).onchange = render;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
      for (const menu of document.querySelectorAll("details[open]")) {
        menu.open = false;
        menu.querySelector("summary").focus();
      }
  });
  document.addEventListener("pointerdown", (event) => {
    for (const menu of document.querySelectorAll("details[open]"))
      if (!menu.contains(event.target)) menu.open = false;
  });
  for (const detail of document.querySelectorAll("details"))
    detail.addEventListener("toggle", () => {
      if (detail.open)
        for (const other of document.querySelectorAll("details"))
          if (other !== detail) other.open = false;
    });
  new ResizeObserver(() => {
    if (ended) {
      render();
    }
  }).observe(canvas);
  window.addEventListener("pagehide", () => {
    port?.postMessage({ type: "derive-cancel" });
    clearEdges();
    for (const entry of buffers) gl.deleteBuffer(entry.buffer);
    for (const mesh of [box, ground, grid, shadow])
      if (mesh) {
        gl.deleteBuffer(mesh.p);
        gl.deleteBuffer(mesh.a);
      }
    port?.close();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  });
}
initializeStlRenderer();

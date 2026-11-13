// Incremental source decoder: retains at most one chunk plus an incomplete record.
function createStlDecoder({ size, onTriangle, onProgress }) {
  let count = 0,
    bytes = 0,
    expected = 0,
    binary,
    pending = new Uint8Array(0),
    text = "",
    vertices = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const triangle = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    onTriangle(ax, ay, az, bx, by, bz, cx, cy, cz);
    count++;
  };
  const parseBinary = (data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    for (; offset + 50 <= data.length; offset += 50) {
      if (count >= expected)
        throw Error("STL has unexpected trailing triangle data.");
      const p = offset + 12;
      triangle(
        view.getFloat32(p, true),
        view.getFloat32(p + 4, true),
        view.getFloat32(p + 8, true),
        view.getFloat32(p + 12, true),
        view.getFloat32(p + 16, true),
        view.getFloat32(p + 20, true),
        view.getFloat32(p + 24, true),
        view.getFloat32(p + 28, true),
        view.getFloat32(p + 32, true),
      );
    }
    pending = data.slice(offset);
  };
  const parseAscii = (data, final = false) => {
    text += decoder.decode(data, { stream: !final });
    const lines = text.split(/\r?\n/);
    text = final ? "" : lines.pop();
    for (const line of lines) {
      if (line.length > 65536) throw Error("Invalid STL line length.");
      if (/^\s*vertex\b/i.test(line)) {
        const m = /^\s*vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s*$/i.exec(line);
        if (!m) throw Error("Malformed ASCII STL vertex.");
        vertices.push(Number(m[1]), Number(m[2]), Number(m[3]));
        if (vertices.length === 9) {
          triangle(...vertices);
          vertices = [];
        }
      }
    }
    if (text.length > 65536) throw Error("Invalid STL line length.");
  };
  const consume = (data) => {
    bytes += data.length;
    if (binary === undefined || binary) {
      const joined = new Uint8Array(pending.length + data.length);
      joined.set(pending);
      joined.set(data, pending.length);
      pending = joined;
      if (binary === undefined && pending.length >= 84) {
        expected = new DataView(pending.buffer).getUint32(80, true);
        binary = 84 + expected * 50 === size;
        const first = pending;
        pending = new Uint8Array(0);
        if (binary) parseBinary(first.subarray(84));
        else parseAscii(first);
      } else if (binary) parseBinary(joined);
    } else parseAscii(data);
    onProgress(count, bytes);
  };
  function finish() {
    if (binary === undefined) {
      parseAscii(pending, true);
      pending = new Uint8Array(0);
    } else if (!binary) parseAscii(new Uint8Array(0), true);
    if (
      bytes !== size ||
      (binary && (pending.length || count !== expected)) ||
      vertices.length ||
      !count
    )
      throw Error("Incomplete or empty STL; full model was not loaded.");
    pending = null;
  }
  return {
    consume,
    finish,
    get count() {
      return count;
    },
  };
}

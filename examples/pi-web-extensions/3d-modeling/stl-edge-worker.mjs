// Fixed-memory external edge sort. Runs only in an owned worker, never the server event loop.
import {
  openSync,
  closeSync,
  readSync,
  writeSync,
  statSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
const RECORD_BYTES = 72,
  RECORDS_PER_RUN = 196608,
  RECORDS_PER_READ = 4096;
const CREASE_COSINE = Math.cos((35 * Math.PI) / 180);
export const EDGE_ALGORITHM = "stl-feature-35-source-normal-weld-1e-7-v1";
function identity(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
}
function decodeBinaryStl(fd, scanBuffer, count, hash, visit) {
  let triangles = 0;
  let remainingTriangles = count;
  while (remainingTriangles) {
    const length = Math.min(remainingTriangles, 16384) * 50;
    let receivedBytes = 0;
    while (receivedBytes < length) {
      const readBytes = readSync(
        fd,
        scanBuffer,
        receivedBytes,
        length - receivedBytes,
        null,
      );
      if (!readBytes) throw Error("STL changed during edge generation.");
      receivedBytes += readBytes;
    }
    hash.update(scanBuffer.subarray(0, length));
    for (let vertexOffset = 0; vertexOffset < length; vertexOffset += 50) {
      visit(scanBuffer, vertexOffset + 12, triangles++);
    }
    remainingTriangles -= length / 50;
  }
  return triangles;
}
function decodeAsciiStl(fd, scanBuffer, hash, visit) {
  let triangles = 0;
  const decoder = new TextDecoder("utf8", { fatal: true }),
    triangle = Buffer.alloc(36);
  let text = "",
    vertices = 0,
    position = 0;
  const line = (lineText) => {
    if (lineText.length > 65536) throw Error("Invalid STL line length.");
    if (!/^\s*vertex\b/i.test(lineText)) return;
    const match = /^\s*vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s*$/i.exec(
      lineText,
    );
    if (!match) throw Error("Malformed ASCII STL vertex.");
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = Number(match[axis + 1]);
      if (!Number.isFinite(coordinate))
        throw Error("STL contains non-finite coordinates.");
      triangle.writeFloatLE(coordinate, vertices * 12 + axis * 4);
    }
    if (++vertices === 3) {
      visit(triangle, 0, triangles++);
      vertices = 0;
    }
  };
  while (true) {
    const length = readSync(fd, scanBuffer, 0, scanBuffer.length, position);
    if (!length) break;
    position += length;
    hash.update(scanBuffer.subarray(0, length));
    text += decoder.decode(scanBuffer.subarray(0, length), { stream: true });
    let at;
    while ((at = text.indexOf("\n")) >= 0) {
      line(text.slice(0, at));
      text = text.slice(at + 1);
    }
    if (text.length > 65536) throw Error("Invalid STL line length.");
  }
  text += decoder.decode();
  if (text) line(text);
  if (vertices || !triangles) throw Error("Incomplete or empty STL.");
  return triangles;
}
function scanStl(path, visit) {
  const before = statSync(path, { bigint: true }),
    fd = openSync(path, "r"),
    hash = createHash("sha256"),
    header = Buffer.alloc(84),
    scanBuffer = Buffer.alloc(50 * 16384);
  let triangles = 0;
  try {
    const headerLength = readSync(fd, header, 0, 84, null),
      count = headerLength === 84 ? header.readUInt32LE(80) : 0;
    if (
      headerLength === 84 &&
      84 + count * 50 === Number(before.size) &&
      count
    ) {
      hash.update(header);
      triangles = decodeBinaryStl(fd, scanBuffer, count, hash, visit);
    } else {
      triangles = decodeAsciiStl(fd, scanBuffer, hash, visit);
    }
  } finally {
    closeSync(fd);
  }
  if (identity(before) !== identity(statSync(path, { bigint: true })))
    throw Error("STL changed during edge generation.");
  return { hash: hash.digest("hex"), identity: identity(before), triangles };
}
export function generateEdges({
  source,
  destination,
  scratch,
  maxScratchBytes = 1536 * 1024 * 1024,
}) {
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const start = performance.now(),
    bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const first = scanStl(source, (buffer, vertexOffset) => {
    for (let vertex = 0; vertex < 3; vertex++)
      for (let axis = 0; axis < 3; axis++) {
        const coordinate = buffer.readFloatLE(
          vertexOffset + vertex * 12 + axis * 4,
        );
        if (!Number.isFinite(coordinate))
          throw Error("STL contains non-finite coordinates.");
        bounds[axis] = Math.min(bounds[axis], coordinate);
        bounds[axis + 3] = Math.max(bounds[axis + 3], coordinate);
      }
  });
  // Worst case includes every run plus an all-boundary output. Reject before allocating disk.
  if (first.triangles * 3 * (RECORD_BYTES + 24) > maxScratchBytes)
    throw Error(
      "Feature outline scratch budget exceeded (1.5 GiB); the full mesh is unchanged.",
    );
  const cell =
    Math.max(
      bounds[3] - bounds[0],
      bounds[4] - bounds[1],
      bounds[5] - bounds[2],
      1,
    ) * 1e-7;
  const sortedRuns = writeSortedRuns({ source, scratch, bounds, cell });
  if (
    first.hash !== sortedRuns.sourceScan.hash ||
    first.identity !== sortedRuns.sourceScan.identity
  )
    throw Error("STL changed during edge generation.");
  const merged = mergeRuns(sortedRuns.runs, destination);
  return {
    algorithm: EDGE_ALGORITHM,
    sourceHash: first.hash,
    outputHash: merged.outputHash,
    triangles: first.triangles,
    lines: merged.lines,
    boundaries: merged.boundaries,
    creases: merged.creases,
    nonmanifold: merged.nonmanifold,
    degenerate: sortedRuns.degenerate,
    cell,
    records: sortedRuns.records,
    scratchBytes: sortedRuns.records * RECORD_BYTES + merged.lines * 24,
    workingBufferBytes:
      sortedRuns.workingBufferBytes + merged.workingBufferBytes + 819200,
    peakRssBytes: Math.max(sortedRuns.peak, process.memoryUsage().rss),
    elapsedMs: performance.now() - start,
  };
}

function writeSortedRuns({ source, scratch, bounds, cell }) {
  const storage = Buffer.allocUnsafe(RECORDS_PER_RUN * RECORD_BYTES),
    view = new DataView(storage.buffer, storage.byteOffset, storage.byteLength),
    order = new Uint32Array(RECORDS_PER_RUN),
    sorted = Buffer.allocUnsafe(storage.length),
    runs = [];
  let usedRecords = 0,
    records = 0,
    degenerate = 0,
    peak = process.memoryUsage().rss;
  const compareRecordKeys = (leftIndex, rightIndex) => {
    for (let axis = 0; axis < 6; axis++) {
      const difference =
        view.getInt32(leftIndex * RECORD_BYTES + axis * 4, true) -
        view.getInt32(rightIndex * RECORD_BYTES + axis * 4, true);
      if (difference) return difference;
    }
    return 0;
  };
  const flushSortedRun = () => {
    if (!usedRecords) return;
    for (let index = 0; index < usedRecords; index++) order[index] = index;
    order.subarray(0, usedRecords).sort(compareRecordKeys);
    for (let index = 0; index < usedRecords; index++)
      storage.copy(
        sorted,
        index * RECORD_BYTES,
        order[index] * RECORD_BYTES,
        (order[index] + 1) * RECORD_BYTES,
      );
    const path = `${scratch}/run-${runs.length}`;
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, sorted, 0, usedRecords * RECORD_BYTES);
    } finally {
      closeSync(fd);
    }
    runs.push(path);
    usedRecords = 0;
    peak = Math.max(peak, process.memoryUsage().rss);
    parentPort?.postMessage({
      type: "progress",
      phase: "sort",
      records,
      runs: runs.length,
    });
  };
  const sourceCoordinates = new Float64Array(9),
    weldedCoordinates = new Int32Array(9);
  const second = scanStl(source, (buffer, vertexOffset) => {
    for (let index = 0; index < 9; index++) {
      sourceCoordinates[index] = buffer.readFloatLE(vertexOffset + index * 4);
      weldedCoordinates[index] = Math.round(
        (sourceCoordinates[index] - bounds[index % 3]) / cell,
      );
    }
    const sameKey = (leftIndex, rightIndex) =>
      weldedCoordinates[leftIndex] === weldedCoordinates[rightIndex] &&
      weldedCoordinates[leftIndex + 1] === weldedCoordinates[rightIndex + 1] &&
      weldedCoordinates[leftIndex + 2] === weldedCoordinates[rightIndex + 2];
    if (sameKey(0, 3) || sameKey(0, 6) || sameKey(3, 6)) {
      degenerate++;
      return;
    }
    const firstSideX = sourceCoordinates[3] - sourceCoordinates[0],
      firstSideY = sourceCoordinates[4] - sourceCoordinates[1],
      firstSideZ = sourceCoordinates[5] - sourceCoordinates[2],
      secondSideX = sourceCoordinates[6] - sourceCoordinates[0],
      secondSideY = sourceCoordinates[7] - sourceCoordinates[1],
      secondSideZ = sourceCoordinates[8] - sourceCoordinates[2];
    let normalX = firstSideY * secondSideZ - firstSideZ * secondSideY,
      normalY = firstSideZ * secondSideX - firstSideX * secondSideZ,
      normalZ = firstSideX * secondSideY - firstSideY * secondSideX;
    const length = Math.hypot(normalX, normalY, normalZ) || 1;
    normalX /= length;
    normalY /= length;
    normalZ /= length;
    for (let edge = 0; edge < 3; edge++) {
      let leftIndex = edge * 3,
        rightIndex = ((edge + 1) % 3) * 3;
      for (let axis = 0; axis < 3; axis++) {
        if (
          weldedCoordinates[leftIndex + axis] ===
          weldedCoordinates[rightIndex + axis]
        )
          continue;
        if (
          weldedCoordinates[leftIndex + axis] >
          weldedCoordinates[rightIndex + axis]
        )
          [leftIndex, rightIndex] = [rightIndex, leftIndex];
        break;
      }
      const offset = usedRecords * RECORD_BYTES;
      for (let axis = 0; axis < 3; axis++) {
        view.setInt32(
          offset + axis * 4,
          weldedCoordinates[leftIndex + axis],
          true,
        );
        view.setInt32(
          offset + 12 + axis * 4,
          weldedCoordinates[rightIndex + axis],
          true,
        );
        view.setFloat32(
          offset + 48 + axis * 4,
          sourceCoordinates[leftIndex + axis],
          true,
        );
        view.setFloat32(
          offset + 60 + axis * 4,
          sourceCoordinates[rightIndex + axis],
          true,
        );
      }
      view.setFloat64(offset + 24, normalX, true);
      view.setFloat64(offset + 32, normalY, true);
      view.setFloat64(offset + 40, normalZ, true);
      usedRecords++;
      records++;
      if (usedRecords === RECORDS_PER_RUN) flushSortedRun();
    }
  });
  flushSortedRun();
  return {
    runs,
    records,
    degenerate,
    peak,
    sourceScan: second,
    workingBufferBytes: storage.length + sorted.length + order.byteLength,
  };
}

function createRunHeap(keyCompare) {
  const heap = [];
  function pushRun(index) {
    let heapPosition = heap.length;
    heap.push(index);
    while (heapPosition) {
      const parentPosition = (heapPosition - 1) >> 1;
      if (keyCompare(heap[parentPosition], index) <= 0) break;
      heap[heapPosition] = heap[parentPosition];
      heapPosition = parentPosition;
    }
    heap[heapPosition] = index;
  }
  function popRun() {
    const top = heap[0],
      last = heap.pop();
    if (heap.length) {
      let heapPosition = 0;
      while (heapPosition * 2 + 1 < heap.length) {
        let childPosition = heapPosition * 2 + 1;
        if (
          childPosition + 1 < heap.length &&
          keyCompare(heap[childPosition + 1], heap[childPosition]) < 0
        )
          childPosition++;
        if (keyCompare(last, heap[childPosition]) <= 0) break;
        heap[heapPosition] = heap[childPosition];
        heapPosition = childPosition;
      }
      heap[heapPosition] = last;
    }
    return top;
  }
  return { heap, pushRun, popRun };
}

// Coincident/repeated faces remain separate incidences. Only exactly two
// sufficiently aligned source-face normals suppress an edge.
function classifyEdges(incidents, normalDot) {
  if (!incidents || (incidents === 2 && normalDot >= CREASE_COSINE))
    return null;
  return incidents === 1
    ? "boundary"
    : incidents === 2
      ? "crease"
      : "nonmanifold";
}

function mergeRuns(runs, destination) {
  // One small input buffer per sorted run; heap stores run indices, never edge objects.
  const readers = runs.map((path) => ({
    fd: openSync(path, "r"),
    buffer: Buffer.alloc(RECORDS_PER_READ * RECORD_BYTES),
    at: 0,
    end: 0,
  }));
  const refill = (reader) => {
    reader.end = readSync(
      reader.fd,
      reader.buffer,
      0,
      reader.buffer.length,
      null,
    );
    reader.at = 0;
    if (reader.end % RECORD_BYTES) throw Error("Malformed private edge run.");
    return !!reader.end;
  };
  const keyCompare = (leftIndex, rightIndex) => {
    const leftReader = readers[leftIndex],
      rightReader = readers[rightIndex];
    for (let axis = 0; axis < 6; axis++) {
      const difference =
        leftReader.buffer.readInt32LE(leftReader.at + axis * 4) -
        rightReader.buffer.readInt32LE(rightReader.at + axis * 4);
      if (difference) return difference;
    }
    return 0;
  };
  const { heap, pushRun, popRun } = createRunHeap(keyCompare);
  const output = Buffer.alloc(24 * 8192),
    group = Buffer.alloc(RECORD_BYTES),
    outputHash = createHash("sha256"),
    outputFd = openSync(destination, "wx", 0o600);
  let outputBytes = 0,
    lines = 0,
    incidents = 0,
    normalDot = 1,
    boundaries = 0,
    creases = 0,
    nonmanifold = 0;
  function emit() {
    const classification = classifyEdges(incidents, normalDot);
    if (!classification) return;
    group.copy(output, outputBytes, 48, 72);
    outputBytes += 24;
    lines++;
    if (classification === "boundary") boundaries++;
    else if (classification === "crease") creases++;
    else nonmanifold++;
    if (outputBytes === output.length) {
      outputHash.update(output);
      writeSync(outputFd, output);
      outputBytes = 0;
    }
  }
  try {
    readers.forEach((reader, index) => {
      if (refill(reader)) pushRun(index);
    });
    while (heap.length) {
      const index = popRun(),
        reader = readers[index];
      let sameKey = incidents > 0;
      for (let axis = 0; sameKey && axis < 6; axis++)
        sameKey =
          group.readInt32LE(axis * 4) ===
          reader.buffer.readInt32LE(reader.at + axis * 4);
      if (!sameKey) {
        emit();
        reader.buffer.copy(group, 0, reader.at, reader.at + RECORD_BYTES);
        incidents = 1;
        normalDot = 1;
      } else {
        incidents++;
        if (incidents === 2)
          normalDot =
            group.readDoubleLE(24) *
              reader.buffer.readDoubleLE(reader.at + 24) +
            group.readDoubleLE(32) *
              reader.buffer.readDoubleLE(reader.at + 32) +
            group.readDoubleLE(40) * reader.buffer.readDoubleLE(reader.at + 40);
      }
      reader.at += RECORD_BYTES;
      if (reader.at < reader.end || refill(reader)) pushRun(index);
    }
    emit();
    if (outputBytes) {
      outputHash.update(output.subarray(0, outputBytes));
      writeSync(outputFd, output, 0, outputBytes);
    }
  } finally {
    closeSync(outputFd);
    for (const reader of readers) closeSync(reader.fd);
    for (const path of runs) unlinkSync(path);
  }
  return {
    outputHash: outputHash.digest("hex"),
    lines,
    boundaries,
    creases,
    nonmanifold,
    workingBufferBytes:
      readers.length * RECORDS_PER_READ * RECORD_BYTES + output.length,
  };
}

if (parentPort && workerData) {
  try {
    parentPort.postMessage({
      type: "complete",
      result: generateEdges(workerData),
    });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: error.message });
  }
}

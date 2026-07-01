const QR_VERSION = 10;
const QR_SIZE = QR_VERSION * 4 + 17;
const QR_ERROR_CORRECTION_FORMAT_BITS = 0; // M
const QR_DATA_CODEWORDS = 216;
const QR_EC_CODEWORDS_PER_BLOCK = 26;
const QR_BLOCK_DATA_LENGTHS = [43, 43, 43, 43, 44] as const;
const QR_ALIGNMENT_POSITIONS = [6, 28, 50] as const;
const QR_MAX_BYTE_LENGTH = Math.floor((QR_DATA_CODEWORDS * 8 - 4 - 16 - 4) / 8);

export function qrMaxByteLength() {
  return QR_MAX_BYTE_LENGTH;
}

export function createQrSvg(text: string, title = "QR code"): SVGSVGElement {
  const matrix = createQrMatrix(text);
  const quietZone = 4;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `${-quietZone} ${-quietZone} ${QR_SIZE + quietZone * 2} ${QR_SIZE + quietZone * 2}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title);
  svg.setAttribute("shape-rendering", "crispEdges");

  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", String(-quietZone));
  background.setAttribute("y", String(-quietZone));
  background.setAttribute("width", String(QR_SIZE + quietZone * 2));
  background.setAttribute("height", String(QR_SIZE + quietZone * 2));
  background.setAttribute("fill", "#fff");

  const modules = document.createElementNS("http://www.w3.org/2000/svg", "path");
  modules.setAttribute("fill", "#000");
  modules.setAttribute("d", matrixToPath(matrix));

  svg.append(background, modules);
  return svg;
}

function createQrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > QR_MAX_BYTE_LENGTH) {
    throw new Error(`QR payload is ${bytes.length} bytes; maximum is ${QR_MAX_BYTE_LENGTH} bytes`);
  }

  const dataCodewords = encodeDataCodewords(bytes);
  const codewords = addErrorCorrection(dataCodewords);
  const modules = blankMatrix(false);
  const isFunction = blankMatrix(false);

  drawFunctionPatterns(modules, isFunction);
  drawCodewords(modules, isFunction, codewords);

  let bestMatrix = modules;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = cloneMatrix(modules);
    applyMask(candidate, isFunction, mask);
    drawFormatBits(candidate, undefined, mask);
    const penalty = scoreMatrix(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMatrix = candidate;
    }
  }

  return bestMatrix;
}

function encodeDataCodewords(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4); // Byte mode
  appendBits(bits, bytes.length, 16); // Version 10 byte-mode character count
  for (const byte of bytes) appendBits(bits, byte, 8);

  const capacityBits = QR_DATA_CODEWORDS * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    data.push(value);
  }

  for (let pad = 0; data.length < QR_DATA_CODEWORDS; pad += 1) {
    data.push(pad % 2 === 0 ? 0xec : 0x11);
  }
  return data;
}

function appendBits(bits: number[], value: number, length: number) {
  if (length < 0 || value >>> length !== 0) throw new Error("Invalid QR bit segment");
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function addErrorCorrection(data: number[]): number[] {
  const blocks: { data: number[]; ecc: number[] }[] = [];
  let offset = 0;
  for (const length of QR_BLOCK_DATA_LENGTHS) {
    const blockData = data.slice(offset, offset + length);
    offset += length;
    blocks.push({ data: blockData, ecc: reedSolomonRemainder(blockData, QR_EC_CODEWORDS_PER_BLOCK) });
  }

  const result: number[] = [];
  const maxDataLength = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxDataLength; i += 1) {
    for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
  }
  for (let i = 0; i < QR_EC_CODEWORDS_PER_BLOCK; i += 1) {
    for (const block of blocks) result.push(block.ecc[i]);
  }
  return result;
}

function reedSolomonRemainder(data: number[], degree: number): number[] {
  const generator = reedSolomonGenerator(degree);
  const message = data.concat(Array(degree).fill(0));
  for (let i = 0; i < data.length; i += 1) {
    const factor = message[i];
    if (factor === 0) continue;
    for (let j = 1; j < generator.length; j += 1) {
      message[i + j] ^= gfMultiply(generator[j], factor);
    }
  }
  return message.slice(data.length);
}

function reedSolomonGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) poly = polynomialMultiply(poly, [1, gfPow(2, i)]);
  return poly;
}

function polynomialMultiply(left: number[], right: number[]): number[] {
  const result = Array(left.length + right.length - 1).fill(0);
  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) {
      result[i + j] ^= gfMultiply(left[i], right[j]);
    }
  }
  return result;
}

function gfPow(value: number, power: number): number {
  let result = 1;
  for (let i = 0; i < power; i += 1) result = gfMultiply(result, value);
  return result;
}

function gfMultiply(left: number, right: number): number {
  let result = 0;
  let a = left;
  let b = right;
  while (b !== 0) {
    if ((b & 1) !== 0) result ^= a;
    a <<= 1;
    if ((a & 0x100) !== 0) a ^= 0x11d;
    b >>>= 1;
  }
  return result;
}

function blankMatrix<T>(value: T): T[][] {
  return Array.from({ length: QR_SIZE }, () => Array<T>(QR_SIZE).fill(value));
}

function cloneMatrix(matrix: boolean[][]): boolean[][] {
  return matrix.map((row) => row.slice());
}

function drawFunctionPatterns(modules: boolean[][], isFunction: boolean[][]) {
  drawFinderPattern(modules, isFunction, 3, 3);
  drawFinderPattern(modules, isFunction, QR_SIZE - 4, 3);
  drawFinderPattern(modules, isFunction, 3, QR_SIZE - 4);

  for (let i = 8; i < QR_SIZE - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunctionModule(modules, isFunction, 6, i, dark);
    setFunctionModule(modules, isFunction, i, 6, dark);
  }

  for (const x of QR_ALIGNMENT_POSITIONS) {
    for (const y of QR_ALIGNMENT_POSITIONS) {
      const overlapsFinder = (x === 6 && y === 6) || (x === 6 && y === QR_SIZE - 7) || (x === QR_SIZE - 7 && y === 6);
      if (!overlapsFinder) drawAlignmentPattern(modules, isFunction, x, y);
    }
  }

  drawFormatBits(modules, isFunction, 0);
  drawVersionBits(modules, isFunction);
}

function drawFinderPattern(modules: boolean[][], isFunction: boolean[][], centerX: number, centerY: number) {
  for (let y = -4; y <= 4; y += 1) {
    for (let x = -4; x <= 4; x += 1) {
      const distance = Math.max(Math.abs(x), Math.abs(y));
      const xx = centerX + x;
      const yy = centerY + y;
      if (xx < 0 || xx >= QR_SIZE || yy < 0 || yy >= QR_SIZE) continue;
      setFunctionModule(modules, isFunction, xx, yy, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignmentPattern(modules: boolean[][], isFunction: boolean[][], centerX: number, centerY: number) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const distance = Math.max(Math.abs(x), Math.abs(y));
      setFunctionModule(modules, isFunction, centerX + x, centerY + y, distance !== 1);
    }
  }
}

function drawFormatBits(modules: boolean[][], isFunction: boolean[][] | undefined, mask: number) {
  const data = (QR_ERROR_CORRECTION_FORMAT_BITS << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;

  for (let i = 0; i <= 5; i += 1) setMaybeFunctionModule(modules, isFunction, 8, i, getBit(bits, i));
  setMaybeFunctionModule(modules, isFunction, 8, 7, getBit(bits, 6));
  setMaybeFunctionModule(modules, isFunction, 8, 8, getBit(bits, 7));
  setMaybeFunctionModule(modules, isFunction, 7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) setMaybeFunctionModule(modules, isFunction, 14 - i, 8, getBit(bits, i));

  for (let i = 0; i < 8; i += 1) setMaybeFunctionModule(modules, isFunction, QR_SIZE - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i += 1) setMaybeFunctionModule(modules, isFunction, 8, QR_SIZE - 15 + i, getBit(bits, i));
  setMaybeFunctionModule(modules, isFunction, 8, QR_SIZE - 8, true);
}

function drawVersionBits(modules: boolean[][], isFunction: boolean[][]) {
  let remainder = QR_VERSION;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25);
  const bits = (QR_VERSION << 12) | remainder;
  for (let i = 0; i < 18; i += 1) {
    const bit = getBit(bits, i);
    const a = QR_SIZE - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(modules, isFunction, a, b, bit);
    setFunctionModule(modules, isFunction, b, a, bit);
  }
}

function setFunctionModule(modules: boolean[][], isFunction: boolean[][], x: number, y: number, dark: boolean) {
  modules[y][x] = dark;
  isFunction[y][x] = true;
}

function setMaybeFunctionModule(modules: boolean[][], isFunction: boolean[][] | undefined, x: number, y: number, dark: boolean) {
  modules[y][x] = dark;
  if (isFunction) isFunction[y][x] = true;
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function drawCodewords(modules: boolean[][], isFunction: boolean[][], codewords: number[]) {
  let bitIndex = 0;
  let upward = true;
  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < QR_SIZE; vertical += 1) {
      const y = upward ? QR_SIZE - 1 - vertical : vertical;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (isFunction[y][x]) continue;
        const byte = codewords[Math.floor(bitIndex / 8)] ?? 0;
        modules[y][x] = ((byte >>> (7 - (bitIndex % 8))) & 1) !== 0;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function applyMask(modules: boolean[][], isFunction: boolean[][], mask: number) {
  for (let y = 0; y < QR_SIZE; y += 1) {
    for (let x = 0; x < QR_SIZE; x += 1) {
      if (!isFunction[y][x] && maskApplies(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error(`Invalid QR mask: ${mask}`);
  }
}

function scoreMatrix(modules: boolean[][]): number {
  let penalty = 0;

  for (let y = 0; y < QR_SIZE; y += 1) penalty += scoreRuns(modules[y]);
  for (let x = 0; x < QR_SIZE; x += 1) {
    const column: boolean[] = [];
    for (let y = 0; y < QR_SIZE; y += 1) column.push(modules[y][x]);
    penalty += scoreRuns(column);
  }

  for (let y = 0; y < QR_SIZE - 1; y += 1) {
    for (let x = 0; x < QR_SIZE - 1; x += 1) {
      const color = modules[y][x];
      if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) penalty += 3;
    }
  }

  for (let y = 0; y < QR_SIZE; y += 1) penalty += scoreFinderLikePatterns(modules[y]);
  for (let x = 0; x < QR_SIZE; x += 1) {
    const column: boolean[] = [];
    for (let y = 0; y < QR_SIZE; y += 1) column.push(modules[y][x]);
    penalty += scoreFinderLikePatterns(column);
  }

  const darkCount = modules.flat().filter(Boolean).length;
  penalty += Math.floor(Math.abs(darkCount * 20 - QR_SIZE * QR_SIZE * 10) / (QR_SIZE * QR_SIZE)) * 10;
  return penalty;
}

function scoreRuns(line: boolean[]): number {
  let penalty = 0;
  let runColor = line[0];
  let runLength = 1;
  for (let i = 1; i < line.length; i += 1) {
    if (line[i] === runColor) {
      runLength += 1;
    } else {
      if (runLength >= 5) penalty += 3 + runLength - 5;
      runColor = line[i];
      runLength = 1;
    }
  }
  if (runLength >= 5) penalty += 3 + runLength - 5;
  return penalty;
}

function scoreFinderLikePatterns(line: boolean[]): number {
  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const reverse = [false, false, false, false, true, false, true, true, true, false, true];
  let penalty = 0;
  for (let i = 0; i <= line.length - pattern.length; i += 1) {
    if (matchesAt(line, pattern, i) || matchesAt(line, reverse, i)) penalty += 40;
  }
  return penalty;
}

function matchesAt(line: boolean[], pattern: boolean[], offset: number): boolean {
  for (let i = 0; i < pattern.length; i += 1) if (line[offset + i] !== pattern[i]) return false;
  return true;
}

function matrixToPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix[y].length; x += 1) {
      if (matrix[y][x]) parts.push(`M${x},${y}h1v1h-1z`);
    }
  }
  return parts.join("");
}

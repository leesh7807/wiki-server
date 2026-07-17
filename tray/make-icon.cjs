const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const icoPath = path.join(__dirname, "icon.ico");
const pngPath = path.join(__dirname, "icon.png");
const sizes = [16, 24, 32, 48, 64, 256];
const images = sizes.map(makeIconImage);

const headerSize = 6;
const entrySize = 16;
let offset = headerSize + entrySize * images.length;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

const entries = [];
for (const image of images) {
  const entry = Buffer.alloc(entrySize);
  entry.writeUInt8(image.width >= 256 ? 0 : image.width, 0);
  entry.writeUInt8(image.height >= 256 ? 0 : image.height, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += image.data.length;
}

fs.writeFileSync(icoPath, Buffer.concat([header, ...entries, ...images.map((image) => image.data)]));
fs.writeFileSync(pngPath, makePngIcon(512));
console.log(icoPath);
console.log(pngPath);

function makeIconImage(size) {
  const dibHeader = Buffer.alloc(40);
  dibHeader.writeUInt32LE(40, 0);
  dibHeader.writeInt32LE(size, 4);
  dibHeader.writeInt32LE(size * 2, 8);
  dibHeader.writeUInt16LE(1, 12);
  dibHeader.writeUInt16LE(32, 14);
  dibHeader.writeUInt32LE(0, 16);
  dibHeader.writeUInt32LE(size * size * 4, 20);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const color = pixelColor(x + 0.5, y + 0.5, size);
      const outY = size - 1 - y;
      const offset = (outY * size + x) * 4;
      pixels[offset] = color.b;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.r;
      pixels[offset + 3] = color.a;
    }
  }

  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  return {
    width: size,
    height: size,
    data: Buffer.concat([dibHeader, pixels, mask]),
  };
}

function makePngIcon(size) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (size * 4 + 1);
    rows[rowOffset] = 0;
    for (let x = 0; x < size; x += 1) {
      const color = pixelColor(x + 0.5, y + 0.5, size);
      const offset = rowOffset + 1 + x * 4;
      rows[offset] = color.r;
      rows[offset + 1] = color.g;
      rows[offset + 2] = color.b;
      rows[offset + 3] = color.a;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pixelColor(x, y, size) {
  const s = size / 256;

  if (!roundedRect(x, y, 0, 0, 256 * s, 256 * s, 56 * s)) {
    return rgba(0, 0, 0, 0);
  }

  let color = rgba(27, 54, 93, 255);
  if (roundedRect(x, y, 66 * s, 36 * s, 130 * s, 178 * s, 18 * s)) {
    color = rgba(245, 244, 237, 255);
  }
  if (roundedRect(x, y, 66 * s, 36 * s, 130 * s, 42 * s, 18 * s)) {
    color = rgba(235, 232, 220, 255);
  }
  if (line(x, y, 94 * s, 92 * s, 162 * s, 92 * s, 14 * s)) {
    color = rgba(27, 54, 93, 255);
  }
  if (line(x, y, 94 * s, 124 * s, 162 * s, 124 * s, 14 * s)) {
    color = rgba(27, 54, 93, 255);
  }
  if (line(x, y, 94 * s, 156 * s, 140 * s, 156 * s, 14 * s)) {
    color = rgba(27, 54, 93, 255);
  }
  if (circle(x, y, 184 * s, 184 * s, 34 * s)) {
    color = rgba(27, 54, 93, 255);
  }
  if (line(x, y, 170 * s, 184 * s, 179 * s, 193 * s, 7 * s) ||
      line(x, y, 179 * s, 193 * s, 198 * s, 171 * s, 7 * s)) {
    color = rgba(255, 255, 255, 255);
  }

  return color;
}

function roundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function circle(x, y, cx, cy, radius) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function line(px, py, x1, y1, x2, y2, width) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return (px - x) ** 2 + (py - y) ** 2 <= (width / 2) ** 2;
}

function rgba(r, g, b, a) {
  return { r, g, b, a };
}

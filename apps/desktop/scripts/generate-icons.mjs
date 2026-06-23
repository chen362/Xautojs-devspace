import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const iconDir = join(desktopRoot, "src-tauri", "icons");

const OUTPUTS = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
];

const ICO_SIZES = [32, 16, 24, 48, 64, 256];
const ICNS_SIZES = [
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
];

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

mkdirSync(iconDir, { recursive: true });

const pngs = new Map();
for (const size of uniqueSizes([...OUTPUTS.map(([, size]) => size), ...ICO_SIZES, ...ICNS_SIZES.map(([, size]) => size)])) {
  pngs.set(size, encodePng(size, size, renderIcon(size)));
}

for (const [name, size] of OUTPUTS) {
  writeFileSync(join(iconDir, name), pngs.get(size));
}

writeFileSync(join(iconDir, "icon.ico"), encodeIco(ICO_SIZES.map((size) => ({ size, png: pngs.get(size) }))));
writeFileSync(join(iconDir, "icon.icns"), encodeIcns(ICNS_SIZES.map(([type, size]) => ({ type, png: pngs.get(size) }))));

console.log(`Generated Xautojs Desktop icons in ${iconDir}`);

function uniqueSizes(sizes) {
  return [...new Set(sizes)].sort((left, right) => left - right);
}

function renderIcon(size) {
  const sample = size >= 512 ? 2 : 4;
  const high = size * sample;
  const highPixels = new Uint8ClampedArray(high * high * 4);

  for (let y = 0; y < high; y += 1) {
    for (let x = 0; x < high; x += 1) {
      const nx = (x + 0.5) / high;
      const ny = (y + 0.5) / high;
      if (!insideRoundedRect(nx, ny, 0.0625, 0.0625, 0.9375, 0.9375, 0.215)) continue;

      let color = [14, 41, 35, 255];
      if (insidePolygon(nx, ny, [[0.0625, 0.72], [0.72, 0.0625], [0.9375, 0.0625], [0.0625, 0.9375]])) {
        color = [18, 92, 74, 255];
      }
      if (insidePolygon(nx, ny, [[0.32, 0.9375], [0.9375, 0.32], [0.9375, 0.9375]])) {
        color = [126, 209, 168, 255];
      }

      if (distanceToSegment(nx, ny, 0.275, 0.275, 0.725, 0.725) <= 0.047) {
        color = [245, 252, 248, 255];
      }
      if (distanceToSegment(nx, ny, 0.725, 0.275, 0.275, 0.725) <= 0.047) {
        color = [245, 252, 248, 255];
      }
      if (distanceToSegment(nx, ny, 0.305, 0.725, 0.725, 0.305) <= 0.014) {
        color = [127, 224, 176, 255];
      }
      if (((nx - 0.743) ** 2) / (0.051 ** 2) + ((ny - 0.743) ** 2) / (0.051 ** 2) <= 1) {
        color = [127, 224, 176, 255];
      }

      const offset = (y * high + x) * 4;
      highPixels[offset] = color[0];
      highPixels[offset + 1] = color[1];
      highPixels[offset + 2] = color[2];
      highPixels[offset + 3] = color[3];
    }
  }

  return downsample(highPixels, size, sample);
}

function downsample(highPixels, size, sample) {
  const pixels = Buffer.alloc(size * size * 4);
  const high = size * sample;
  const divisor = sample * sample;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sy = 0; sy < sample; sy += 1) {
        for (let sx = 0; sx < sample; sx += 1) {
          const offset = (((y * sample + sy) * high) + (x * sample + sx)) * 4;
          red += highPixels[offset];
          green += highPixels[offset + 1];
          blue += highPixels[offset + 2];
          alpha += highPixels[offset + 3];
        }
      }
      const output = (y * size + x) * 4;
      pixels[output] = Math.round(red / divisor);
      pixels[output + 1] = Math.round(green / divisor);
      pixels[output + 2] = Math.round(blue / divisor);
      pixels[output + 3] = Math.round(alpha / divisor);
    }
  }

  return pixels;
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function encodePng(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([u32(data.length), typeBuffer, data, u32(crc32(Buffer.concat([typeBuffer, data])))]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  const payloads = [];
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size === 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size === 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    payloads.push(image.png);
    offset += image.png.length;
  }

  return Buffer.concat([header, ...entries, ...payloads]);
}

function encodeIcns(images) {
  const chunks = images.map((image) => Buffer.concat([
    Buffer.from(image.type, "ascii"),
    u32(image.png.length + 8),
    image.png,
  ]));
  const body = Buffer.concat(chunks);
  return Buffer.concat([Buffer.from("icns", "ascii"), u32(body.length + 8), body]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

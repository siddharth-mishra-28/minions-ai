/**
 * Icon helpers for the Minions-ai executables.
 *
 * Windows gets its icon from docs/media/minions-ai.ico. macOS and Linux build
 * their icons from docs/media/minions-ai-icon.png with zlib only, so the same
 * artwork is used on every platform and no native image library is required.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { dirname } from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG into straight RGBA pixels. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('icon source is not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const parts = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error('icon source must be an 8-bit RGB or RGBA, non-interlaced PNG');
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      current[x] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      out[target] = current[source];
      out[target + 1] = current[source + 1];
      out[target + 2] = current[source + 2];
      out[target + 3] = channels === 4 ? current[source + 3] : 255;
    }
    previous = current;
  }
  return { width, height, data: out };
}

/** Encode straight RGBA pixels as an 8-bit PNG. */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Box-filter resize with premultiplied alpha. Every target icon is smaller than
 * the 1024 px master, so area averaging keeps the flat artwork crisp and avoids
 * dark fringes around the rounded plaque.
 */
export function resizeIcon(image, size) {
  const { width: sourceWidth, height: sourceHeight, data: source } = image;
  if (size === sourceWidth && size === sourceHeight) return image;
  const target = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    const y0 = (y * sourceHeight) / size;
    const y1 = ((y + 1) * sourceHeight) / size;
    for (let x = 0; x < size; x++) {
      const x0 = (x * sourceWidth) / size;
      const x1 = ((x + 1) * sourceWidth) / size;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alphaWeight = 0;
      let weight = 0;

      for (let sy = Math.floor(y0); sy < Math.min(sourceHeight, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(sourceWidth, Math.ceil(x1)); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const index = (sy * sourceWidth + sx) * 4;
          const alpha = source[index + 3] / 255;
          red += source[index] * alpha * w;
          green += source[index + 1] * alpha * w;
          blue += source[index + 2] * alpha * w;
          alphaWeight += source[index + 3] * w;
          weight += w;
        }
      }

      const out = (y * size + x) * 4;
      if (weight === 0) continue;
      const alpha = alphaWeight / weight;
      target[out + 3] = Math.round(alpha);
      if (alpha > 0) {
        const base = (alpha / 255) * weight;
        target[out] = Math.round(red / base);
        target[out + 1] = Math.round(green / base);
        target[out + 2] = Math.round(blue / base);
      }
    }
  }
  return { width: size, height: size, data: target };
}

const ICNS_TYPES = [
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
  [32, 'ic11'],
  [64, 'ic12'],
  [256, 'ic13'],
  [512, 'ic14'],
];

/** Write a macOS .icns containing PNG payloads for every standard size. */
export function writeIcns(path, image) {
  const cache = new Map();
  const icon = (size) => {
    if (!cache.has(size)) cache.set(size, encodePng(resizeIcon(image, size)));
    return cache.get(size);
  };
  const chunks = ICNS_TYPES.map(([size, type]) => {
    const png = icon(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 'latin1');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'latin1');
  header.writeUInt32BE(body.length + 8, 4);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, body]));
  return ICNS_TYPES.length;
}

/** Write a hicolor PNG icon set for Linux desktops. */
export function writeIconSet(directory, image, sizes = [16, 24, 32, 48, 64, 128, 256, 512]) {
  mkdirSync(directory, { recursive: true });
  for (const size of sizes) {
    writeFileSync(`${directory}/minions-ai-${size}.png`, encodePng(resizeIcon(image, size)));
  }
  return sizes;
}

export function loadIconMaster(path) {
  return decodePng(readFileSync(path));
}

/** Copy any PNG file into an icon of an exact square size. */
export function writePng(path, image, size) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePng(resizeIcon(image, size)));
}

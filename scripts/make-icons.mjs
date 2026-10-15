import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const offset = row + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function blend(base, over, alpha) {
  return base.map((channel, index) => Math.round(channel * (1 - alpha) + over[index] * alpha));
}

function scene(x, y) {
  const meadow = [63, 107, 78];
  let color = [...meadow, 255];
  const sun = (x - 0.68) ** 2 + (y - 0.28) ** 2;
  if (sun < 0.018) color = [231, 184, 90, 255];
  const hill = y > 0.58 + Math.sin(x * 9) * 0.03;
  if (hill) color = blend(color, [215, 228, 212], 1);
  const roof = y > 0.48 && y < 0.62 && Math.abs(x - 0.42) < (0.62 - y) * 0.7;
  if (roof) color = [138, 90, 59, 255];
  const house = x > 0.32 && x < 0.52 && y > 0.6 && y < 0.78;
  if (house) color = [247, 241, 230, 255];
  const window = (x - 0.42) ** 2 + (y - 0.68) ** 2 < 0.0016;
  if (window) color = [196, 138, 42, 255];
  const corner = Math.min(x, y, 1 - x, 1 - y);
  if (corner < 0.08) {
    const fade = Math.max(0, corner / 0.08);
    color = [...color.slice(0, 3), Math.round(255 * fade)];
  }
  return color;
}

for (const size of [192, 512]) {
  writeFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url), png(size, scene));
}

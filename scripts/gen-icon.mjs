// Generates StretchWidget app icons at 16, 32, 256 px using only Node built-ins.
// Run: node scripts/gen-icon.mjs
import { writeFileSync } from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildIconPng(size) {
  const W = size, H = size;
  // RGBA pixel buffer (initialized transparent)
  const pixels = new Uint8Array(W * H * 4);

  function setPixel(xi, yi, r, g, b, a = 255) {
    xi = Math.round(xi); yi = Math.round(yi);
    if (xi < 0 || xi >= W || yi < 0 || yi >= H) return;
    const i = (yi * W + xi) * 4;
    const srcA = a / 255, dstA = pixels[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) return;
    pixels[i]     = Math.round((r * srcA + pixels[i]     * dstA * (1 - srcA)) / outA);
    pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
    pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
    pixels[i + 3] = Math.round(outA * 255);
  }

  function fillCircle(cx, cy, radius, r, g, b, a = 255) {
    const r2 = radius * radius;
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
      for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
        if (dx * dx + dy * dy <= r2) setPixel(cx + dx, cy + dy, r, g, b, a);
      }
    }
  }

  function drawLine(x1, y1, x2, y2, thickness, r, g, b) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(len * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      fillCircle(x1 + dx * t, y1 + dy * t, thickness / 2, r, g, b);
    }
  }

  const s = size / 256;
  const [TR, TG, TB] = [0, 184, 148]; // #00B894 teal

  // Rounded background (teal)
  const bgR = Math.round(size * 0.2); // corner radius ≈20%
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nearX = Math.max(bgR, Math.min(x, W - 1 - bgR));
      const nearY = Math.max(bgR, Math.min(y, H - 1 - bgR));
      const dx = x - nearX, dy = y - nearY;
      if (dx * dx + dy * dy <= bgR * bgR) setPixel(x, y, TR, TG, TB);
    }
  }

  // Stick figure (person stretching, arms raised in Y shape) — coords in 256-space, scaled by s
  const cx = 128 * s;           // horizontal center
  const headCY  = 50 * s;
  const headR   = Math.max(1.5, 20 * s);
  const neckY   = (50 + 20) * s;
  const shouldY = 100 * s;
  const hipY    = 165 * s;
  const thick   = Math.max(1, Math.round(11 * s));

  // Head
  fillCircle(cx, headCY, headR, 255, 255, 255);

  // Torso: neck → hip
  drawLine(cx, neckY, cx, hipY, thick, 255, 255, 255);

  // Left arm: shoulder → upper-left
  drawLine(cx, shouldY, 52 * s, 50 * s, thick, 255, 255, 255);
  // Right arm: shoulder → upper-right
  drawLine(cx, shouldY, 204 * s, 50 * s, thick, 255, 255, 255);

  // Left leg: hip → lower-left
  drawLine(cx, hipY, 75 * s, 225 * s, thick, 255, 255, 255);
  // Right leg: hip → lower-right
  drawLine(cx, hipY, 181 * s, 225 * s, thick, 255, 255, 255);

  // --- PNG encoder (RGBA, color type 6) ---
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const mkChunk = (type, data) => {
    const lenBuf = Buffer.allocUnsafe(4); lenBuf.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.allocUnsafe(4); crcBuf.writeUInt32BE(crc32(body));
    return Buffer.concat([lenBuf, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit depth, RGBA

  const stride = 1 + W * 4;
  const raw = Buffer.alloc(H * stride);
  for (let y = 0; y < H; y++) {
    raw[y * stride] = 0; // filter: None
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      const di = y * stride + 1 + x * 4;
      raw[di] = pixels[si]; raw[di + 1] = pixels[si + 1];
      raw[di + 2] = pixels[si + 2]; raw[di + 3] = pixels[si + 3];
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    mkChunk('IHDR', ihdr),
    mkChunk('IDAT', zlib.deflateSync(raw)),
    mkChunk('IEND', Buffer.alloc(0)),
  ]);
}

const publicDir = path.join(__dirname, '../public');
for (const size of [16, 32, 256]) {
  const buf = buildIconPng(size);
  const out = path.join(publicDir, `icon-${size}.png`);
  writeFileSync(out, buf);
  console.log(`✓ ${out} (${buf.length} bytes)`);
}
console.log('Done. Icons saved to public/');

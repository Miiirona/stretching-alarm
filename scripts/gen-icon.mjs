// Generates StretchWidget app icons — teal background + white bell silhouette.
// Run: node scripts/gen-icon.mjs
import { writeFileSync } from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildIconPng(size) {
  const W = size, H = size;
  const pixels = new Uint8Array(W * H * 4); // RGBA, transparent

  function setPixel(x, y, r, g, b, a = 255) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    const sa = a / 255, da = pixels[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    pixels[i]     = Math.round((r * sa + pixels[i]     * da * (1 - sa)) / oa);
    pixels[i + 1] = Math.round((g * sa + pixels[i + 1] * da * (1 - sa)) / oa);
    pixels[i + 2] = Math.round((b * sa + pixels[i + 2] * da * (1 - sa)) / oa);
    pixels[i + 3] = Math.round(oa * 255);
  }

  function fillHLine(x0, x1, y, r, g, b) {
    for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) setPixel(x, y, r, g, b);
  }

  function fillCircle(cx, cy, radius, r, g, b) {
    const r2 = radius * radius;
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
      for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
        if (dx * dx + dy * dy <= r2) setPixel(cx + dx, cy + dy, r, g, b);
      }
    }
  }

  const s = size / 256;
  const cx = W / 2;
  const [TR, TG, TB] = [0, 184, 148];  // #00B894 teal
  const [WR, WG, WB] = [255, 255, 255];

  // --- Teal rounded background ---
  const bgR = Math.round(size * 0.2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = Math.max(bgR, Math.min(x, W - 1 - bgR));
      const ny = Math.max(bgR, Math.min(y, H - 1 - bgR));
      const dx = x - nx, dy = y - ny;
      if (dx * dx + dy * dy <= bgR * bgR) setPixel(x, y, TR, TG, TB);
    }
  }

  // --- Bell silhouette (white) ---
  // All coordinates are in 256-space, scaled by s.

  // 1. Knob / loop at top
  const knobHW  = 10 * s;
  const knobTop = Math.ceil(18 * s);
  const knobBot = Math.floor(32 * s);
  for (let y = knobTop; y <= knobBot; y++) fillHLine(cx - knobHW, cx + knobHW, y, WR, WG, WB);

  // 2. Dome arch (upper semicircle)
  //    Center at (cx, archCY), radius archR — only draw y <= archCY (top half)
  const archCY = 118 * s;
  const archR  = 86 * s;
  const archTop = Math.ceil((archCY - archR));
  for (let y = Math.max(archTop, Math.ceil(knobBot)); y <= Math.floor(archCY); y++) {
    const dy = archCY - y;
    const hw = Math.sqrt(Math.max(0, archR * archR - dy * dy));
    fillHLine(cx - hw, cx + hw, y, WR, WG, WB);
  }

  // 3. Straight body (arch center down to rim top)
  const rimTop = Math.ceil(185 * s);
  for (let y = Math.floor(archCY); y <= rimTop; y++) {
    fillHLine(cx - archR, cx + archR, y, WR, WG, WB);
  }

  // 4. Rim (wider horizontal bar)
  const rimBot = Math.floor(205 * s);
  const rimHW  = archR + 16 * s;
  for (let y = rimTop; y <= rimBot; y++) fillHLine(cx - rimHW, cx + rimHW, y, WR, WG, WB);

  // 5. Clapper (small filled circle below rim)
  const clapperY = 223 * s;
  const clapperR = Math.max(1, 11 * s);
  fillCircle(cx, clapperY, clapperR, WR, WG, WB);

  // --- PNG encoder (RGBA, color type 6) ---
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const mkChunk = (type, data) => {
    const lenBuf = Buffer.allocUnsafe(4); lenBuf.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcBuf = Buffer.allocUnsafe(4); crcBuf.writeUInt32BE(crc32(body));
    return Buffer.concat([lenBuf, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const stride = 1 + W * 4;
  const raw = Buffer.alloc(H * stride);
  for (let y = 0; y < H; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4, di = y * stride + 1 + x * 4;
      raw[di] = pixels[si]; raw[di+1] = pixels[si+1];
      raw[di+2] = pixels[si+2]; raw[di+3] = pixels[si+3];
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
console.log('Done.');

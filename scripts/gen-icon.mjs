// Generates StretchWidget app icons — teal bell on transparent background.
// Outputs: public/icon-{16,32,48,256}.png  and  build/icon.ico
// Run: node scripts/gen-icon.mjs
import { writeFileSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── PNG builder ────────────────────────────────────────────────────────────────
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
  const [TR, TG, TB] = [0, 184, 148]; // #00B894

  // Bell silhouette — all coords in 256-space, scaled by s

  // 1. Knob
  const knobHW = 10 * s;
  const knobTop = Math.ceil(18 * s), knobBot = Math.floor(32 * s);
  for (let y = knobTop; y <= knobBot; y++) fillHLine(cx - knobHW, cx + knobHW, y, TR, TG, TB);

  // 2. Dome arch (upper semicircle)
  const archCY = 118 * s, archR = 86 * s;
  for (let y = Math.max(Math.ceil(archCY - archR), knobBot); y <= Math.floor(archCY); y++) {
    const hw = Math.sqrt(Math.max(0, archR * archR - (archCY - y) ** 2));
    fillHLine(cx - hw, cx + hw, y, TR, TG, TB);
  }

  // 3. Straight body
  const rimTop = Math.ceil(185 * s);
  for (let y = Math.floor(archCY); y <= rimTop; y++) fillHLine(cx - archR, cx + archR, y, TR, TG, TB);

  // 4. Rim
  const rimBot = Math.floor(205 * s), rimHW = archR + 16 * s;
  for (let y = rimTop; y <= rimBot; y++) fillHLine(cx - rimHW, cx + rimHW, y, TR, TG, TB);

  // 5. Clapper
  fillCircle(cx, 223 * s, Math.max(1, 11 * s), TR, TG, TB);

  // PNG encoder (RGBA, color type 6)
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

// ── ICO builder (PNG-in-ICO, Windows Vista+) ──────────────────────────────────
function buildIco(entries) {
  // entries: [{ size, buf }]  — buf must be a valid PNG Buffer
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);              // type: 1 = ICO
  header.writeUInt16LE(entries.length, 4);

  const dirOffset = 6 + entries.length * 16;
  const dirs = [];
  let offset = dirOffset;

  for (const { size, buf } of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size; // width  (0 = 256)
    dir[1] = size >= 256 ? 0 : size; // height
    dir[2] = 0;                       // color count (0 = true color)
    dir[3] = 0;                       // reserved
    dir.writeUInt16LE(1, 4);          // planes
    dir.writeUInt16LE(32, 6);         // bits per pixel
    dir.writeUInt32LE(buf.length, 8); // image data size
    dir.writeUInt32LE(offset, 12);    // image data offset
    dirs.push(dir);
    offset += buf.length;
  }

  return Buffer.concat([header, ...dirs, ...entries.map(e => e.buf)]);
}

// ── Generate files ─────────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, '../public');
const buildDir  = path.join(__dirname, '../build');

mkdirSync(buildDir, { recursive: true });

const pngs = {};
for (const size of [16, 32, 48, 256, 512]) {
  pngs[size] = buildIconPng(size);
  const out = path.join(publicDir, `icon-${size}.png`);
  writeFileSync(out, pngs[size]);
  console.log(`✓ public/icon-${size}.png  (${pngs[size].length} B)`);
}

// ICO bundles 16 / 32 / 48 / 256 — used by electron-builder for NSIS & MSIX
const ico = buildIco([16, 32, 48, 256].map(s => ({ size: s, buf: pngs[s] })));
const icoPath = path.join(buildDir, 'icon.ico');
writeFileSync(icoPath, ico);
console.log(`✓ build/icon.ico           (${ico.length} B)`);

console.log('\nDone. Run `npm run build:nsis` or `npm run build:msix` to package.');

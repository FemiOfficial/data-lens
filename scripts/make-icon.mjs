// Renders the 128×128 marketplace icon (grid + lens) without any image deps.
import fs from 'node:fs';
import zlib from 'node:zlib';
const S = 128, px = new Uint8Array(S * S * 4);
const blend = (x, y, [r, g, b], a) => {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const i = (y * S + x) * 4, ia = 1 - a;
  px[i] = r * a + px[i] * ia; px[i + 1] = g * a + px[i + 1] * ia; px[i + 2] = b * a + px[i + 2] * ia; px[i + 3] = Math.min(255, 255 * a + px[i + 3] * ia);
};
const sdfRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r)), cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return Math.hypot(x - cx, y - cy) - r;
};
const blue = [42, 120, 214], white = [255, 255, 255], orange = [235, 104, 52];
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const d = sdfRoundRect(x + 0.5, y + 0.5, 4, 4, 124, 124, 26);
  blend(x, y, blue, Math.max(0, Math.min(1, 0.5 - d)));
}
// spreadsheet grid
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const inGrid = x >= 22 && x <= 86 && y >= 26 && y <= 90;
  if (!inGrid) continue;
  const line = [22, 43, 64, 86].some((v) => Math.abs(x - v) < 1.6) || [26, 47, 68, 90].some((v) => Math.abs(y - v) < 1.6);
  const header = y < 47;
  if (line) blend(x, y, white, 0.95);
  else if (header) blend(x, y, white, 0.35);
}
// lens
const cx = 84, cy = 84;
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  blend(x, y, blue, Math.max(0, Math.min(1, 24.5 - d)) * 0.85);
  blend(x, y, white, Math.max(0, Math.min(1, 1 - Math.abs(d - 21) + 3.2)) );
  // handle
  const t = Math.max(0, Math.min(1, ((x - cx) + (y - cy)) / 2 / 40));
  const hx = cx + 15 + t * 22, hy = cy + 15 + t * 22;
  if (t > 0 && t < 1) blend(x, y, white, Math.max(0, Math.min(1, 6 - Math.hypot(x + 0.5 - hx, y + 0.5 - hy))));
}
// bars inside lens
[[74, 14], [83, 22], [92, 10]].forEach(([bx, h]) => { for (let y = 94 - h; y <= 94; y++) for (let x = bx; x < bx + 6; x++) blend(x, y, orange, 1); });
// PNG encode
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1); }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
for (const out of ['vscode/media/icon.png']) { fs.mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true }); fs.writeFileSync(out, png); }
console.log('icon written');

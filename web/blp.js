// BLP2 texture decoder -> { width, height, rgba: Uint8ClampedArray }
// maxSize: picks the first mip level whose larger side is <= maxSize (faster previews).

function c565(c, out, o) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 2) | (g >> 4); out[o + 2] = (b << 3) | (b >> 2);
}

function decodeDXT(src, w, h, kind) {
  const out = new Uint8ClampedArray(w * h * 4);
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const blockSize = kind === 1 ? 8 : 16;
  const col = new Uint8Array(16), alpha = new Uint8Array(16);
  let p = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, p += blockSize) {
      if (p + blockSize > src.length) return out;
      let cp = p;
      if (kind === 3) { // DXT3 explicit alpha
        for (let i = 0; i < 8; i++) { const v = src[p + i]; alpha[i * 2] = (v & 15) * 17; alpha[i * 2 + 1] = (v >> 4) * 17; }
        cp = p + 8;
      } else if (kind === 5) { // DXT5 interpolated alpha
        const a0 = src[p], a1 = src[p + 1];
        const pal = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7 | 0);
        else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5 | 0); pal.push(0, 255); }
        let bits = 0, nb = 0, bi = p + 2;
        for (let i = 0; i < 16; i++) {
          if (nb < 3) { bits |= src[bi++] << nb; nb += 8; }
          alpha[i] = pal[bits & 7]; bits >>= 3; nb -= 3;
        }
        cp = p + 8;
      }
      const c0 = src[cp] | (src[cp + 1] << 8), c1 = src[cp + 2] | (src[cp + 3] << 8);
      c565(c0, col, 0); c565(c1, col, 4);
      col[3] = col[7] = 255;
      if (c0 > c1 || kind !== 1) {
        for (let k = 0; k < 3; k++) { col[8 + k] = (2 * col[k] + col[4 + k]) / 3 | 0; col[12 + k] = (col[k] + 2 * col[4 + k]) / 3 | 0; }
        col[11] = col[15] = 255;
      } else {
        for (let k = 0; k < 3; k++) { col[8 + k] = (col[k] + col[4 + k]) >> 1; col[12 + k] = 0; }
        col[11] = 255; col[15] = 0;
      }
      const idx = src[cp + 4] | (src[cp + 5] << 8) | (src[cp + 6] << 16) | (src[cp + 7] << 24);
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py; if (y >= h) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px; if (x >= w) continue;
          const i = py * 4 + px, ci = ((idx >>> (2 * i)) & 3) * 4, o = (y * w + x) * 4;
          out[o] = col[ci]; out[o + 1] = col[ci + 1]; out[o + 2] = col[ci + 2];
          out[o + 3] = kind === 1 ? col[ci + 3] : alpha[i];
        }
      }
    }
  }
  return out;
}

export function decodeBLP(u8, maxSize = 4096) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== "BLP2") throw new Error("not a BLP2 texture (" + magic + ")");
  const compression = u8[8], alphaDepth = u8[9], alphaType = u8[10];
  let w = dv.getUint32(12, true), h = dv.getUint32(16, true);
  const offs = [], sizes = [];
  for (let i = 0; i < 16; i++) { offs.push(dv.getUint32(20 + i * 4, true)); sizes.push(dv.getUint32(84 + i * 4, true)); }
  let mip = 0;
  while (Math.max(w, h) > maxSize && offs[mip + 1] && sizes[mip + 1]) { mip++; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
  const src = u8.subarray(offs[mip], offs[mip] + sizes[mip]);
  let rgba;
  if (compression === 2) {
    const kind = alphaType === 7 ? 5 : alphaType === 1 ? 3 : (alphaDepth > 1 ? 3 : 1);
    rgba = decodeDXT(src, w, h, kind);
  } else if (compression === 3) {
    rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { rgba[i * 4] = src[i * 4 + 2]; rgba[i * 4 + 1] = src[i * 4 + 1]; rgba[i * 4 + 2] = src[i * 4]; rgba[i * 4 + 3] = src[i * 4 + 3]; }
  } else if (compression === 1) {
    rgba = new Uint8ClampedArray(w * h * 4);
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const c = dv.getUint32(148 + src[i] * 4, true);
      rgba[i * 4] = (c >> 16) & 255; rgba[i * 4 + 1] = (c >> 8) & 255; rgba[i * 4 + 2] = c & 255;
      let a = 255;
      if (alphaDepth === 8) a = src[n + i];
      else if (alphaDepth === 1) a = (src[n + (i >> 3)] >> (i & 7)) & 1 ? 255 : 0;
      else if (alphaDepth === 4) a = ((src[n + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      rgba[i * 4 + 3] = a;
    }
  } else throw new Error("unsupported BLP compression " + compression);
  return { width: w, height: h, rgba, fullWidth: dv.getUint32(12, true), fullHeight: dv.getUint32(16, true) };
}

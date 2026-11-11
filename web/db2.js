// Minimal WDC5 (DB2) reader. Field values come back as numbers (or arrays for array fields).
// Strings (non-sparse tables): db.str(row, fieldIndex). Sparse tables: row.raw holds the record bytes.

const HDR_OFF = 136;

export class DB2 {
  constructor(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== "WDC5") throw new Error("not WDC5: " + magic);
    let p = HDR_OFF;
    const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };
    const u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; };
    const h = this.h = {};
    h.rc = u32(); h.fc = u32(); h.rs = u32(); h.sbs = u32(); h.th = u32(); h.lh = u32(); h.minid = u32(); h.maxid = u32(); h.loc = u32();
    h.flags = u16(); h.idi = u16(); h.tfc = u32(); h.bpo = u32(); h.lc = u32(); h.fsis = u32(); h.cds = u32(); h.pds = u32(); h.sc = u32();
    const sections = [];
    for (let i = 0; i < h.sc; i++) {
      const s = { tact: dv.getBigUint64(p, true) }; p += 8;
      s.off = u32(); s.rc = u32(); s.sts = u32(); s.ore = u32(); s.idls = u32(); s.rels = u32(); s.omc = u32(); s.ctc = u32();
      sections.push(s);
    }
    const fstruct = []; for (let i = 0; i < h.fc; i++) { fstruct.push({ size: dv.getInt16(p, true), offset: dv.getUint16(p + 2, true) }); p += 4; }
    const finfo = [];
    for (let i = 0; i < h.fc; i++) { finfo.push({ offBits: dv.getUint16(p, true), sizeBits: dv.getUint16(p + 2, true), add: dv.getUint32(p + 4, true), st: dv.getUint32(p + 8, true), v1: dv.getUint32(p + 12, true), v2: dv.getUint32(p + 16, true), v3: dv.getUint32(p + 20, true) }); p += 24; }
    this.fstruct = fstruct; this.finfo = finfo;
    const palletStart = p; p += h.pds;
    const commonStart = p; p += h.cds;
    // per-field pallet / common
    let po = palletStart, co = commonStart;
    for (const f of finfo) {
      if (f.st === 3 || f.st === 4) { f.pallet = new Uint32Array(Uint8Array.prototype.slice.call(u8, po, po + f.add).buffer); po += f.add; }
      else if (f.st === 2) { f.common = new Map(); for (let k = 0; k < f.add / 8; k++) f.common.set(dv.getUint32(co + k * 8, true), dv.getUint32(co + k * 8 + 4, true)); co += f.add; }
    }
    this.sparse = !!(h.flags & 1);
    this.sections = sections;
    this.rows = [];
    this.byId = new Map();
    this.u8 = u8; this.dv = dv;
    // string tables concatenated for non-sparse tables
    let totalRecBytes = 0; for (const s of sections) totalRecBytes += s.rc * h.rs;
    this.stringBase = [];
    let strAcc = 0;
    let recIndexBase = 0;
    for (const s of sections) {
      const encrypted = s.tact !== 0n;
      let q = s.off;
      let recStarts = [], recSizes = [];
      if (!this.sparse) {
        for (let i = 0; i < s.rc; i++) { recStarts.push(q + i * h.rs); recSizes.push(h.rs); }
        s.strStart = q + s.rc * h.rs;
        q += s.rc * h.rs + s.sts;
      } else {
        q = s.ore;
      }
      const ids = []; for (let i = 0; i < s.idls / 4; i++) ids.push(dv.getUint32(q + i * 4, true)); q += s.idls;
      const copies = []; for (let i = 0; i < s.ctc; i++) copies.push([dv.getUint32(q + i * 8, true), dv.getUint32(q + i * 8 + 4, true)]); q += s.ctc * 8;
      const omap = []; for (let i = 0; i < s.omc; i++) omap.push([dv.getUint32(q + i * 6, true), dv.getUint16(q + i * 6 + 4, true)]); q += s.omc * 6;
      const rel = new Map();
      if (s.rels) { const n = dv.getUint32(q, true); for (let k = 0; k < n; k++) rel.set(dv.getUint32(q + 12 + k * 8 + 4, true), dv.getUint32(q + 12 + k * 8, true)); q += s.rels; }
      const omIds = []; for (let i = 0; i < s.omc; i++) omIds.push(dv.getUint32(q + i * 4, true)); q += s.omc * 4;
      if (this.sparse) { for (const [o, sz] of omap) { recStarts.push(o); recSizes.push(sz); } }
      const n = this.sparse ? omap.length : s.rc;
      // skip encrypted sections whose data is zero-filled
      if (encrypted) { let nz = false; for (let i = s.off; i < Math.min(s.off + 64, u8.length); i++) if (u8[i]) { nz = true; break; } if (!nz) { recIndexBase += s.rc; strAcc += s.sts; continue; } }
      for (let i = 0; i < n; i++) {
        const start = recStarts[i];
        const row = { start, size: recSizes[i], sec: s, gi: recIndexBase + i, strBase: strAcc, totalRecBytes };
        if (this.sparse) { row.raw = u8.subarray(start, start + recSizes[i]); row.id = ids[i] ?? omIds[i]; }
        else {
          row.v = this.readFields(start);
          row.id = ids.length ? ids[i] : row.v[h.idi];
          if (rel.has(i)) row.rel = rel.get(i);
        }
        this.rows.push(row); this.byId.set(row.id, row);
      }
      for (const [newId, oldId] of copies) { const r = this.byId.get(oldId); if (r) { const c = { ...r, id: newId }; this.rows.push(c); this.byId.set(newId, c); } }
      recIndexBase += s.rc; strAcc += s.sts;
    }
  }

  bits(start, off, size) {
    let v = 0n; const nbytes = ((off + size + 7) >> 3) - (off >> 3);
    for (let i = nbytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.u8[start + (off >> 3) + i]);
    v >>= BigInt(off & 7);
    return Number(v & ((1n << BigInt(size)) - 1n));
  }

  readFields(start) {
    const out = [];
    for (const f of this.finfo) {
      if (f.st === 0) {
        if (f.sizeBits > 32) { const c = f.sizeBits / 32; const a = []; for (let k = 0; k < c; k++) a.push(this.dv.getUint32(start + (f.offBits >> 3) + 4 * k, true)); out.push(a); }
        else if (f.sizeBits === 32) out.push(this.dv.getUint32(start + (f.offBits >> 3), true));
        else out.push(this.bits(start, f.offBits, f.sizeBits));
      } else if (f.st === 1 || f.st === 5) {
        let v = this.bits(start, f.offBits, f.sizeBits);
        if (f.st === 5 && v >= 2 ** (f.sizeBits - 1)) v -= 2 ** f.sizeBits;
        out.push(v);
      } else if (f.st === 2) out.push(null);
      else if (f.st === 3) out.push(f.pallet[this.bits(start, f.offBits, f.sizeBits)]);
      else if (f.st === 4) { const i = this.bits(start, f.offBits, f.sizeBits); out.push(Array.from(f.pallet.subarray(i * f.v3, (i + 1) * f.v3))); }
      else out.push(null);
    }
    return out;
  }

  get(id) { return this.byId.get(id); }
  val(row, fi) {
    const v = row.v[fi];
    if (v === null && this.finfo[fi].st === 2) return this.finfo[fi].common.get(row.id) ?? this.finfo[fi].v1;
    return v;
  }
  // string field for non-sparse tables (value = offset relative to the field position)
  str(row, fi, k = 0) {
    const f = this.finfo[fi];
    const fieldPos = row.gi * this.h.rs + (f.offBits >> 3) + 4 * k;
    const ofs = this.dv.getUint32(row.start + (f.offBits >> 3) + 4 * k, true);
    let idx = fieldPos + ofs - row.totalRecBytes; // index into concatenated string tables
    // locate the section holding this string
    let acc = 0;
    for (const s of this.sections) { if (idx < acc + s.sts) { const a = s.strStart + (idx - acc); return this.cstr(a); } acc += s.sts; }
    return "";
  }
  cstr(a) { let e = a; while (e < this.u8.length && this.u8[e]) e++; return new TextDecoder().decode(this.u8.subarray(a, e)); }
}

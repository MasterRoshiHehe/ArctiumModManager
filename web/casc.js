// Read-only local CASC reader (WoW game data). Environment agnostic:
// io = { read(relPath, offset, length) -> Promise<Uint8Array>, readText(relPath) -> Promise<string>,
//        list(relDir) -> Promise<string[]> (file names), inflate(Uint8Array) -> Promise<Uint8Array> }
// relPath is relative to the WoW root folder (the one holding .build.info and Data\).

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => { const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
function cmp(a, aOff, b, bOff, n) { for (let i = 0; i < n; i++) { const d = a[aOff + i] - b[bOff + i]; if (d) return d; } return 0; }

export class Casc {
  constructor(io, product = "_forever_") { this.io = io; this.product = product; }

  async open(log = () => {}) {
    const io = this.io;
    const bi = (await io.readText(".build.info")).split(/\r?\n/).filter(Boolean);
    const hdr = bi[0].split("|").map((h) => h.split("!")[0]);
    let row = null;
    for (const ln of bi.slice(1)) {
      const r = Object.fromEntries(ln.split("|").map((v, i) => [hdr[i], v]));
      if (r.Active === "1" && (!row || r.Product === "wowf")) row = r;
    }
    if (!row) throw new Error("no active build in .build.info");
    this.version = row.Version;
    const cfgText = await io.readText(`Data/config/${row["Build Key"].slice(0, 2)}/${row["Build Key"].slice(2, 4)}/${row["Build Key"]}`);
    this.buildConfig = {};
    for (const l of cfgText.split(/\r?\n/)) { const i = l.indexOf("="); if (i > 0) this.buildConfig[l.slice(0, i).trim()] = l.slice(i + 1).trim().split(/\s+/); }

    // --- local indices: newest .idx per bucket, kept raw and binary-searched
    log("Reading game index files...");
    const names = (await io.list("Data/data")).filter((n) => /\.idx$/i.test(n)).sort();
    const latest = {};
    for (const n of names) latest[parseInt(n.slice(0, 2), 16)] = n;
    this.buckets = [];
    for (let b = 0; b < 16; b++) {
      if (!latest[b]) { this.buckets[b] = null; continue; }
      const f = await io.read(`Data/data/${latest[b]}`);
      const dv = new DataView(f.buffer, f.byteOffset, f.byteLength);
      const hsize = dv.getUint32(0, true);
      let pos = (8 + hsize + 15) & ~15;
      const esize = dv.getUint32(pos, true); pos += 8;
      this.buckets[b] = { buf: f, start: pos, count: Math.floor(esize / 18) };
    }

    // --- encoding (page table kept, pages searched on demand)
    log("Reading game encoding table...");
    const enc = await this.readEKey(unhex(this.buildConfig.encoding[1]));
    const edv = new DataView(enc.buffer, enc.byteOffset, enc.byteLength);
    if (enc[0] !== 0x45 || enc[1] !== 0x4e) throw new Error("bad encoding header");
    this.ckeySize = enc[3]; this.ekeySize = enc[4];
    const pageKB = edv.getUint16(5);
    const pages = edv.getUint32(9);
    const especSize = edv.getUint32(18);
    const tbl = 22 + especSize;
    this.enc = enc; this.encPageSize = pageKB * 1024; this.encPages = pages;
    this.encTable = tbl; this.encData = tbl + pages * 32;

    // --- root (MFST): fid -> offset of ckey in root buffer
    log("Reading game file list...");
    const root = await this.readCKey(unhex(this.buildConfig.root[0]));
    this.root = root;
    const rdv = new DataView(root.buffer, root.byteOffset, root.byteLength);
    const fidMap = new Map();
    const pri = new Map();
    const dupes = new Map();
    this.dupes = dupes;
    let pos, ver;
    if (root[0] === 0x54 && root[1] === 0x53 && root[2] === 0x46 && root[3] === 0x4d) {
      const hsz = rdv.getUint32(4, true); ver = rdv.getUint32(8, true);
      if (hsz > 1000) { pos = 12; ver = 1; } else pos = hsz;
    } else { pos = 0; ver = 0; }
    while (pos < root.length) {
      let n, locale, content;
      if (ver >= 2) { n = rdv.getUint32(pos, true); locale = rdv.getUint32(pos + 4, true); content = rdv.getUint32(pos + 8, true) | rdv.getUint32(pos + 12, true) | (root[pos + 16] << 17); pos += 17; }
      else { n = rdv.getUint32(pos, true); content = rdv.getUint32(pos + 4, true); locale = rdv.getUint32(pos + 8, true); pos += 12; }
      const deltas = pos; pos += 4 * n;
      const ckeys = pos; pos += 16 * n;
      if (ver === 0 || !(content & 0x10000000)) pos += 8 * n;
      const p = (locale & 0x2) ? 2 : (locale === 0xffffffff || locale === 0) ? 1 : 0;
      let fid = -1;
      for (let i = 0; i < n; i++) {
        fid = fid + 1 + rdv.getInt32(deltas + 4 * i, true);
        const old = pri.get(fid);
        if (old === undefined) { fidMap.set(fid, ckeys + 16 * i); pri.set(fid, p); }
        else {
          // same file listed more than once (other locale / content flags): remember all, best first
          let alt = dupes.get(fid); if (!alt) dupes.set(fid, (alt = [fidMap.get(fid)]));
          if (p > old) { alt.unshift(ckeys + 16 * i); fidMap.set(fid, ckeys + 16 * i); pri.set(fid, p); } else alt.push(ckeys + 16 * i);
        }
      }
    }
    this.fids = fidMap;
    log(`Game data ready (${fidMap.size} files).`);
    return this;
  }

  has(fid) { return this.fids.has(fid); }

  async readFid(fid) {
    const off = this.fids.get(fid);
    if (off === undefined) throw new Error(`file ${fid} is not in the game data`);
    const alts = this.dupes.get(fid) || [off];
    let err;
    for (const o of alts) {
      try { return await this.readCKey(this.root.subarray(o, o + 16)); } catch (e) { err = e; }
    }
    throw err;
  }

  encodingLookup(ck) {
    const { enc, encTable, encPages, encPageSize, encData, ckeySize, ekeySize } = this;
    let lo = 0, hi = encPages - 1, page = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cmp(enc, encTable + mid * 32, ck, 0, ckeySize) <= 0) { page = mid; lo = mid + 1; } else hi = mid - 1; }
    if (page < 0) return null;
    const p0 = encData + page * encPageSize, end = p0 + encPageSize;
    let i = p0;
    while (i + 6 + ckeySize <= end) {
      const cnt = enc[i]; if (!cnt) break;
      if (cmp(enc, i + 6, ck, 0, ckeySize) === 0) return enc.subarray(i + 6 + ckeySize, i + 6 + ckeySize + ekeySize);
      i += 6 + ckeySize + cnt * ekeySize;
    }
    return null;
  }

  async readCKey(ck) {
    const ek = this.encodingLookup(ck);
    if (!ek) throw new Error("content key not in encoding table: " + hex(ck));
    return this.readEKey(ek);
  }

  indexLookup(ek) {
    let x = 0; for (let i = 0; i < 9; i++) x ^= ek[i];
    const b = this.buckets[(x & 0xf) ^ (x >> 4)];
    if (!b) return null;
    let lo = 0, hi = b.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, o = b.start + mid * 18;
      const c = cmp(b.buf, o, ek, 0, 9);
      if (c === 0) {
        const e = b.buf;
        const hiB = e[o + 9];
        const v = ((e[o + 10] << 24) | (e[o + 11] << 16) | (e[o + 12] << 8) | e[o + 13]) >>> 0;
        const archive = (hiB << 2) | (v >>> 30);
        const offset = v & 0x3fffffff;
        const size = e[o + 14] | (e[o + 15] << 8) | (e[o + 16] << 16) | (e[o + 17] << 24);
        return { archive, offset, size: size >>> 0 };
      }
      if (c < 0) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  async readEKey(ek) {
    const loc = this.indexLookup(ek);
    if (!loc) throw new Error("file not stored locally (not downloaded): " + hex(ek.subarray(0, 9)));
    const raw = await this.io.read(`Data/data/data.${String(loc.archive).padStart(3, "0")}`, loc.offset, loc.size);
    return this.blte(raw.subarray(30));
  }

  async blte(b) {
    if (b[0] !== 0x42 || b[1] !== 0x4c || b[2] !== 0x54 || b[3] !== 0x45) throw new Error("not BLTE");
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const hs = dv.getUint32(4);
    let chunks = [], dsizes = [], pos;
    if (hs === 0) { chunks = [b.length - 8]; pos = 8; }
    else {
      const cnt = (b[9] << 16) | (b[10] << 8) | b[11];
      for (let i = 0; i < cnt; i++) { chunks.push(dv.getUint32(12 + i * 24)); dsizes.push(dv.getUint32(16 + i * 24)); }
      pos = hs;
    }
    const parts = []; let total = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
      const cs = chunks[ci];
      const c = b.subarray(pos, pos + cs); pos += cs;
      let out;
      if (c[0] === 0x4e) out = c.subarray(1);
      else if (c[0] === 0x5a) out = await this.io.inflate(c.subarray(1));
      else if (c[0] === 0x45) { // encrypted chunk: zero-fill (DB2 hotfix sections etc.)
        if (chunks.length === 1 || !dsizes[ci]) throw new Error("encrypted game file");
        out = new Uint8Array(dsizes[ci]); this.encryptedChunks = (this.encryptedChunks || 0) + 1;
      }
      else throw new Error("unknown BLTE chunk " + String.fromCharCode(c[0]));
      parts.push(out); total += out.length;
    }
    if (parts.length === 1) return parts[0];
    const o = new Uint8Array(total); let p = 0;
    for (const x of parts) { o.set(x, p); p += x.length; }
    return o;
  }
}

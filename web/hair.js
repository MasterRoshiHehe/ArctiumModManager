// Hair mixer: copy one hairstyle (skin section id 1-99) from a donor model into a body model.
// The donor's vertices are added to the body, their bones matched by name (CRC) or key-bone id,
// and moved so the donor's head bone sits on the body's head bone. The body's own copy of that
// hairstyle is emptied. Only new files are produced; the inputs are never changed.

const DV = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength);
const pad16 = (n) => (n + 15) & ~15;

export function chunkList(u8) {
  const dv = DV(u8), out = [];
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "MD21") throw new Error("only chunked (MD21) models can be mixed");
  for (let p = 0; p + 8 <= u8.length;) {
    const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    const size = dv.getUint32(p + 4, true);
    out.push({ id, data: u8.subarray(p + 8, p + 8 + size) });
    p += 8 + size;
  }
  return out;
}
const chunk = (list, id) => list.find((c) => c.id === id)?.data;
function readBoneArray(u8, n, off) {
  const d = DV(u8), b = [];
  for (let i = 0; i < n; i++) {
    const o = off + i * 88;
    b.push({ key: d.getInt32(o, true), parent: d.getInt16(o + 8, true), crc: d.getUint32(o + 12, true), pivot: [d.getFloat32(o + 76, true), d.getFloat32(o + 80, true), d.getFloat32(o + 84, true)] });
  }
  return b;
}
// What skeleton a model needs: bones inside the m2, or the fid of its .skel file
export function skeletonOf(m2u8) {
  const ch = chunkList(m2u8), md = chunk(ch, "MD21"), d = DV(md);
  const n = d.getUint32(0x2c, true);
  if (n) return { bones: readBoneArray(md, n, d.getUint32(0x30, true)) };
  const sk = chunk(ch, "SKID");
  return { skelFid: sk ? DV(sk).getUint32(0, true) : 0 };
}
// .skel: bones in SKB1, or in the parent skeleton named by SKPD
export function skelBones(u8) {
  const ch = chunkList2(u8);
  const b = chunk(ch, "SKB1");
  if (b) { const d = DV(b); return { bones: readBoneArray(b, d.getUint32(0, true), d.getUint32(4, true)) }; }
  const p = chunk(ch, "SKPD");
  return { parentFid: p ? DV(p).getUint32(8, true) : 0, bones: null };
}
function chunkList2(u8) { const dv = DV(u8), out = []; for (let p = 0; p + 8 <= u8.length;) { const size = dv.getUint32(p + 4, true); out.push({ id: String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]), data: u8.subarray(p + 8, p + 8 + size) }); p += 8 + size; } return out; }

function readSkin(u8) {
  const d = DV(u8);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== "SKIN") throw new Error("not a .skin file");
  const a = (o) => [d.getUint32(o, true), d.getUint32(o + 4, true)];
  const [nv, ov] = a(4), [ni, oi] = a(12), [nb, ob] = a(20), [ns, os] = a(28), [nt, ot] = a(36);
  const vmap = []; for (let i = 0; i < nv; i++) vmap.push(d.getUint16(ov + i * 2, true));
  const tri = []; for (let i = 0; i < ni; i++) tri.push(d.getUint16(oi + i * 2, true));
  const bones = []; for (let i = 0; i < nb; i++) bones.push(u8.slice(ob + i * 4, ob + i * 4 + 4));
  const subs = []; for (let i = 0; i < ns; i++) subs.push(u8.slice(os + i * 48, os + i * 48 + 48));
  const batches = []; for (let i = 0; i < nt; i++) batches.push(u8.slice(ot + i * 24, ot + i * 24 + 24));
  return { raw: u8, vmap, tri, bones, subs, batches };
}
const subInfo = (r) => { const d = DV(r); const level = d.getUint16(2, true); return { id: d.getUint16(0, true), level, indexStart: d.getUint16(8, true) + (level << 16), indexCount: d.getUint16(10, true), boneComboIndex: d.getUint16(14, true), center: d.getUint16(18, true) }; };

function readM2(u8) {
  const list = chunkList(u8), md = chunk(list, "MD21"), d = DV(md);
  const nv = d.getUint32(0x3c, true), ov = d.getUint32(0x40, true);
  const nc = d.getUint32(0x78, true), oc = d.getUint32(0x7c, true);
  const combos = []; for (let i = 0; i < nc; i++) combos.push(d.getUint16(oc + i * 2, true));
  const nt = d.getUint32(0x50, true), ot = d.getUint32(0x54, true);
  const texType = []; for (let i = 0; i < nt; i++) texType.push(d.getUint32(ot + i * 16, true));
  const nl = d.getUint32(0x80, true), ol = d.getUint32(0x84, true);
  const texLookup = []; for (let i = 0; i < nl; i++) texLookup.push(d.getInt16(ol + i * 2, true));
  return { list, md, nv, verts: md.subarray(ov, ov + nv * 48), combos, texType, texLookup };
}
const batchTexType = (m, b) => m.texType[m.texLookup[DV(b).getUint16(16, true)]];

// Ids of the hairstyles (1-99) a skin has
export function hairIdsOf(skinU8) {
  const s = readSkin(skinU8), ids = new Set();
  for (const r of s.subs) { const i = subInfo(r); if (i.id > 0 && i.id < 100 && i.indexCount) ids.add(i.id); }
  return ids;
}

function boneMap(dBones, tBones) {
  const byCrc = new Map(), byKey = new Map();
  tBones.forEach((b, i) => { if (b.crc && !byCrc.has(b.crc)) byCrc.set(b.crc, i); if (b.key >= 0 && !byKey.has(b.key)) byKey.set(b.key, i); });
  const head = byKey.get(6) ?? 0;
  const direct = (b) => (b.crc && byCrc.has(b.crc) ? byCrc.get(b.crc) : b.key >= 0 && byKey.has(b.key) ? byKey.get(b.key) : undefined);
  let matched = 0;
  const map = dBones.map((b) => {
    let x = b, t, guard = 0;
    while (x && (t = direct(x)) === undefined && guard++ < 300) x = x.parent >= 0 ? dBones[x.parent] : null;
    if (x === b && t !== undefined) matched++;
    return t ?? head;
  });
  return { map, matched };
}
const headPivot = (bones) => bones.find((b) => b.key === 6)?.pivot;

// target: { m2, skin, bones }; donors: [{ id, m2, skin, bones, fit }]
// returns { m2, skin, notes }
export function mixHair(target, donors) {
  const T = readM2(target.m2), TS = readSkin(target.skin), notes = [];
  let maxUsed = 0; for (const v of TS.vmap) if (v > maxUsed) maxUsed = v;
  const newVerts = []; // Uint8Array(48) each, become global ids maxUsed+1+k
  const tHair = TS.batches.filter((b) => { const s = subInfo(TS.subs[DV(b).getUint16(4, true)]); return s.id > 0 && s.id < 100; });
  for (const don of donors) {
    const from = don.from ?? don.id; // donor hairstyle, put into the body's hairstyle slot don.id
    const D = readM2(don.m2), DS = readSkin(don.skin);
    if (!target.bones || !target.bones.length) throw new Error("the body model's skeleton could not be read");
    if (!don.bones || !don.bones.length) throw new Error("the donor model's skeleton could not be read");
    const { map, matched } = boneMap(don.bones, target.bones);
    let off = [0, 0, 0];
    const th = headPivot(target.bones), dh = headPivot(don.bones);
    if (don.fit !== false && th && dh) off = [th[0] - dh[0], th[1] - dh[1], th[2] - dh[2]];
    // room check first: a skin can address at most 65,535 vertices, so skip a hairstyle that doesn't fit instead of failing all
    let need = 0;
    for (const dr of DS.subs) { const ds = subInfo(dr); if (ds.id !== from || !ds.indexCount) continue; const u = new Set(); for (let k = 0; k < ds.indexCount; k++) u.add(DS.tri[ds.indexStart + k]); need += u.size; }
    if (!need) { notes.push(`hairstyle ${don.id}: skipped, that model has no hairstyle ${from}`); continue; }
    if (TS.vmap.length + need > 65535 || maxUsed + 1 + newVerts.length + need > 65535) { notes.push(`hairstyle ${don.id}: skipped, the model is full (too many vertices); replace fewer hairstyles`); continue; }
    // empty the body's own copy
    for (const r of TS.subs) { const i = subInfo(r); if (i.id === don.id) DV(r).setUint16(10, 0, true); }
    let added = 0;
    DS.subs.forEach((dr, di) => {
      const ds = subInfo(dr);
      if (ds.id !== from || !ds.indexCount) return;
      const localOf = new Map(); // donor skin vertex -> new skin vertex
      const sliceOf = new Map(), slice = [];
      const tri = [];
      const vStart = TS.vmap.length;
      for (let k = 0; k < ds.indexCount; k++) {
        const sv = DS.tri[ds.indexStart + k];
        let nvx = localOf.get(sv);
        if (nvx === undefined) {
          const gv = DS.vmap[sv];
          const v = D.verts.slice(gv * 48, gv * 48 + 48), vd = DV(v);
          for (let a = 0; a < 3; a++) vd.setFloat32(a * 4, vd.getFloat32(a * 4, true) + off[a], true);
          const sb = new Uint8Array(4);
          for (let j = 0; j < 4; j++) {
            const tb = map[v[16 + j]] ?? 0;
            if (tb > 255) throw new Error("bone number too high for the body model");
            v[16 + j] = tb;
            if (!v[12 + j]) { sb[j] = 0; continue; }
            if (!sliceOf.has(tb)) { sliceOf.set(tb, slice.length); slice.push(tb); }
            sb[j] = sliceOf.get(tb);
          }
          nvx = TS.vmap.length;
          TS.vmap.push(maxUsed + 1 + newVerts.length);
          newVerts.push(v);
          TS.bones.push(sb);
          localOf.set(sv, nvx);
        }
        tri.push(nvx);
      }
      if (!slice.length) { slice.push(map[0] ?? 0); }
      if (slice.length > 256) throw new Error("hairstyle uses too many bones");
      if (TS.vmap.length > 65535) throw new Error("the combined model has too many vertices (over 65,535)");
      if (maxUsed + 1 + newVerts.length > 65535) throw new Error("the body model has too many vertices to add this hairstyle");
      const comboStart = T.combos.length; T.combos.push(...slice);
      if (comboStart > 65535) throw new Error("bone table too large");
      const iStart = TS.tri.length; TS.tri.push(...tri);
      const r = dr.slice(), d = DV(r);
      d.setUint16(0, don.id, true);
      d.setUint16(2, iStart >>> 16, true);
      d.setUint16(4, vStart, true); d.setUint16(6, TS.vmap.length - vStart, true);
      d.setUint16(8, iStart & 0xffff, true); d.setUint16(10, tri.length, true);
      d.setUint16(12, slice.length, true); d.setUint16(14, comboStart, true);
      const cb = map[ds.center]; d.setUint16(18, cb ?? slice[0], true);
      for (const o of [20, 32]) for (let a = 0; a < 3; a++) d.setFloat32(o + a * 4, d.getFloat32(o + a * 4, true) + off[a], true);
      const newSub = TS.subs.length; TS.subs.push(r);
      // draw calls: borrow the body's own hair draw settings (texture, material) of the same texture type
      for (const db of DS.batches) {
        if (DV(db).getUint16(4, true) !== di) continue;
        const want = batchTexType(D, db);
        const tmpl = tHair.find((b) => subInfo(TS.subs[DV(b).getUint16(4, true)]).id === don.id && batchTexType(T, b) === want)
          || tHair.find((b) => batchTexType(T, b) === want)
          || TS.batches.find((b) => batchTexType(T, b) === want)
          || tHair[0];
        if (!tmpl) throw new Error("the body model has no hair to copy settings from");
        const nb = tmpl.slice(); DV(nb).setUint16(4, newSub, true);
        TS.batches.push(nb);
      }
      added += tri.length / 3;
    });
    if (!added) throw new Error("the donor model has no hairstyle " + from);
    notes.push(`hairstyle ${don.id}${from !== don.id ? " (from its style " + from + ")" : ""}: ${added} triangles, ${matched}/${don.bones.length} donor bones matched by name` + (off.some((x) => Math.abs(x) > 1e-4) ? `, moved ${off.map((x) => x.toFixed(2)).join("/")} to fit the head` : ""));
  }
  return { m2: writeM2(T, maxUsed, newVerts), skin: writeSkin(TS), notes };
}

function writeM2(T, maxUsed, newVerts) {
  const md = T.md;
  const keep = Math.min(T.nv, maxUsed + 1);
  const nv = T.nv + newVerts.length;
  const vOff = pad16(md.length), cOff = pad16(vOff + nv * 48), end = cOff + T.combos.length * 2;
  const out = new Uint8Array(end);
  out.set(md);
  out.set(T.verts.subarray(0, keep * 48), vOff);
  newVerts.forEach((v, k) => out.set(v, vOff + (keep + k) * 48));
  out.set(T.verts.subarray(keep * 48), vOff + (keep + newVerts.length) * 48);
  const d = DV(out);
  T.combos.forEach((c, i) => d.setUint16(cOff + i * 2, c, true));
  d.setUint32(0x3c, nv, true); d.setUint32(0x40, vOff, true);
  d.setUint32(0x78, T.combos.length, true); d.setUint32(0x7c, cOff, true);
  // re-chunk: MD21 first, the rest unchanged
  const parts = T.list.map((c) => (c.id === "MD21" ? { id: "MD21", data: out } : c));
  const total = parts.reduce((n, c) => n + 8 + c.data.length, 0);
  const f = new Uint8Array(total), fd = DV(f);
  let p = 0;
  for (const c of parts) { for (let i = 0; i < 4; i++) f[p + i] = c.id.charCodeAt(i); fd.setUint32(p + 4, c.data.length, true); f.set(c.data, p + 8); p += 8 + c.data.length; }
  return f;
}
function writeSkin(S) {
  const raw = S.raw;
  let p = pad16(raw.length);
  const at = {};
  const sizes = [["v", S.vmap.length * 2], ["i", S.tri.length * 2], ["b", S.bones.length * 4], ["s", S.subs.length * 48], ["t", S.batches.length * 24]];
  for (const [k, n] of sizes) { at[k] = p; p = pad16(p + n); }
  const out = new Uint8Array(p); out.set(raw);
  const d = DV(out);
  S.vmap.forEach((v, i) => d.setUint16(at.v + i * 2, v, true));
  S.tri.forEach((v, i) => d.setUint16(at.i + i * 2, v, true));
  S.bones.forEach((b, i) => out.set(b, at.b + i * 4));
  S.subs.forEach((r, i) => out.set(r, at.s + i * 48));
  S.batches.forEach((r, i) => out.set(r, at.t + i * 24));
  const set = (o, n, off) => { d.setUint32(o, n, true); d.setUint32(o + 4, off, true); };
  set(4, S.vmap.length, at.v); set(12, S.tri.length, at.i); set(20, S.bones.length, at.b); set(28, S.subs.length, at.s); set(36, S.batches.length, at.t);
  return out;
}

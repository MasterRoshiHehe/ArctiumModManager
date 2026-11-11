import { DB2 } from "../web/db2.js"; import fs from "fs";
const L = (f) => new DB2(new Uint8Array(fs.readFileSync(`out/${f}.db2`)));
const sp = L(1572924), it = L(841626), ima = L(982457), ia = L(982462), idi = L(1266429), mr = L(1280614), tfd = L(982459), mfd = L(1337833);
const name = (id) => { const r = sp.get(id); if (!r) return null; const s = []; let a = 0; const raw = r.raw; for (let k = 0; k < 6; k++) { let e = a; while (raw[e]) e++; s.push(Buffer.from(raw.subarray(a, e)).toString()); a = e + 1; } return s; };
for (const id of [25, 6948, 2586, 16921, 19019]) console.log(id, JSON.stringify(name(id)), JSON.stringify(it.get(id)?.v));
const byItem = new Map(); for (const r of ima.rows) { const iid = r.v[1]; if (!byItem.has(iid)) byItem.set(iid, []); byItem.get(iid).push(r); }
for (const id of [25, 16921, 19019]) { const rs = byItem.get(id) || []; console.log("ima", id, rs.map(r => JSON.stringify(r.v))); for (const r of rs) { const a = ia.get(r.v[3]); console.log(" ia", a && JSON.stringify(a.v)); if (!a) continue; const d = idi.get(a.v[1]); console.log(" idi", a.v[1], d && JSON.stringify(d.v)); } }
const matByIdi = new Map(); for (const r of mr.rows) { if (!matByIdi.has(r.rel)) matByIdi.set(r.rel, []); matByIdi.get(r.rel).push(r.v); }
console.log("mr sample rel", mr.rows.slice(0,3).map(r=>[r.id,r.rel,r.v]));
const tByMat = new Map(); for (const r of tfd.rows) { const m = r.v[2]; if (!tByMat.has(m)) tByMat.set(m, []); tByMat.get(m).push(r.id); }
const mByRes = new Map(); for (const r of mfd.rows) { const m = r.v[4]; if (!mByRes.has(m)) mByRes.set(m, []); mByRes.get(m).push(r.v[1]); }
const lf = new Map(); for (const l of fs.readFileSync(process.argv[2], "utf8").split("\n")) { const i = l.indexOf(";"); lf.set(+l.slice(0, i), l.slice(i + 1).trim()); }
for (const id of [25, 16921, 19019]) { for (const r of byItem.get(id) || []) { const a = ia.get(r.v[3]); if (!a) continue; const did = a.v[1]; const d = idi.get(did);
  console.log("ITEM", id, name(id)[4], "display", did);
  for (const [sec, mat] of matByIdi.get(did) || []) console.log("  sec", sec, (tByMat.get(mat) || []).map(f => f + " " + lf.get(f)));
  if (d) { for (const res of d.v[10]) if (res) console.log("  model", res, (mByRes.get(res) || []).map(f => f + " " + lf.get(f))); for (const res of d.v[11]) if (res) console.log("  modeltex", res, (tByMat.get(res) || []).map(f => f + " " + lf.get(f))); }
} }

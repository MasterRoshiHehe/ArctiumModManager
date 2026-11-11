import { Casc } from "../web/casc.js"; import { DB2 } from "../web/db2.js"; import { nodeIO } from "./nodeio.mjs"; import fs from "fs";
const c = await new Casc(nodeIO(process.argv[2])).open(()=>{});
for (const fid of process.argv.slice(3).map(Number)) {
  try { const b = await c.readFid(fid); fs.writeFileSync(`out/${fid}.db2`, b); const d = new DB2(b);
    console.log("==", fid, JSON.stringify(d.h), "sparse", d.sparse, "rows", d.rows.length, "secs", d.sections.map(s=>[s.tact.toString(16), s.rc, s.omc].join("/")).join(" "));
    console.log(" finfo", d.finfo.map(f=>f.st+":"+f.sizeBits).join(" "));
    for (const r of d.rows.slice(0, 4)) console.log("  ", r.id, d.sparse ? Buffer.from(r.raw.subarray(0, 120)).toString("latin1").replace(/[^\x20-\x7e]/g, ".") : JSON.stringify(r.v));
  } catch (e) { console.log(fid, "ERR", e.stack); }
}

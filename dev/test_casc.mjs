import { Casc } from "../web/casc.js"; import { nodeIO } from "./nodeio.mjs"; import fs from "fs";
const root = process.argv[2];
const t = Date.now();
const c = await new Casc(nodeIO(root)).open(console.log);
console.log("open ms", Date.now() - t, c.version, process.memoryUsage().rss >> 20, "MB");
for (const fid of process.argv.slice(3).map(Number)) {
  try { const b = await c.readFid(fid); console.log(fid, b.length, Buffer.from(b.subarray(0, 4)).toString()); fs.writeFileSync(`out/${fid}.bin`, b); } catch (e) { console.log(fid, "ERR", e.message); }
}

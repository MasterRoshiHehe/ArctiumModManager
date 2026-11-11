import { parseM2, parseSkin } from "../web/m2.js"; import { decodeBLP } from "../web/blp.js"; import fs from "fs";
for (const f of process.argv.slice(2)) {
  const b = new Uint8Array(fs.readFileSync(f));
  try {
  if (/\.m2$|\.bin$/i.test(f) && (b[0]==77)) { const m = parseM2(b); console.log(f, m.name, "v", m.version, "verts", m.pos.length/3, "skins", m.numSkins, m.skinFids, "chunks", m.chunks.join(","));
    console.log(" textures", JSON.stringify(m.textures), "lookup", m.textureLookup.slice(0,20)); }
  else if (b[0]==83) { const s = parseSkin(b); console.log(f, "submeshes", s.submeshes.length, "ids", [...new Set(s.submeshes.map(x=>x.id))].join(" "), "batches", s.batches.length); }
  else { const t0=Date.now(); const t = decodeBLP(b); console.log(f, t.fullWidth, t.fullHeight, "->", t.width, t.height, Date.now()-t0, "ms", t.rgba.slice(0,8)); }
  } catch(e) { console.log(f, "ERR", e.message); }
}

import { Casc } from "../web/casc.js"; import { nodeIO } from "./nodeio.mjs"; import { parseM2, parseSkin } from "../web/m2.js";
const c = await new Casc(nodeIO(process.env.HOME + "/mnt/World of Warcraft")).open(() => {});
const m = parseM2(await c.readFid(+process.argv[2]));
const sk = parseSkin(await c.readFid(m.skinFids[0]));
console.log("textures", m.textures.map((t, i) => i + ":" + t.type + (t.fid ? "/" + t.fid : "")).join(" "));
console.log("lookup", m.textureLookup.join(","));
const rows = {};
for (const b of sk.batches) { const sm = sk.submeshes[b.submesh]; const k = sm.id; (rows[k] ||= []).push(`combo${b.textureCombo}x${b.textureCount}->tex${m.textureLookup[b.textureCombo]}(type ${m.textures[m.textureLookup[b.textureCombo]]?.type}) mat${b.materialIndex} blend${m.materials[b.materialIndex]?.blend} layer${b.layer} shader${b.shader}`); }
for (const id of [0, 1, 2, 3201, 3202, 3301, 3401, 3501, 2001, 2201, 2301, 1801, 1701, 701]) if (rows[id]) console.log(id, rows[id].join(" | "));

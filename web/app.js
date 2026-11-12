import { Casc } from "./casc.js";
import { parseM2, parseSkin, TEX_TYPES } from "./m2.js";
import { decodeBLP } from "./blp.js";
import { DB2 } from "./db2.js";
import { ChrData, paintType } from "./chr.js";
import { mixHair, skeletonOf, skelBones, hairIdsOf } from "./hair.js";
import { Viewer, dataTexture, canvasTexture } from "./viewer.js";

// ---------------------------------------------------------------- helpers
const $ = (s, r = document) => r.querySelector(s);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v; else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "disabled" || k === "selected" || k === "value") e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const status = (t) => { $("#status").textContent = t; };
const busy = (t) => { const b = $("#busy"); if (t) { b.textContent = t; b.classList.remove("hide"); } else b.classList.add("hide"); };
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p) => p.slice(0, p.lastIndexOf("/"));
const winJoin = (a, rel) => a.replace(/[\\/]+$/, "") + "\\" + rel.replace(/\//g, "\\");
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : (n / 1024).toFixed(0) + " KB";

async function api(path, params = {}, opts = {}) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(path + (q ? "?" + q : ""), opts);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r;
}
const apiText = async (p, q, o) => (await api(p, q, o)).text();
const apiBytes = async (p, q) => new Uint8Array(await (await api(p, q)).arrayBuffer());
const readAbs = (abs) => apiBytes("/api/read", { p: abs });

async function inflate(u8) {
  const ds = new DecompressionStream("deflate");
  const w = ds.writable.getWriter(); w.write(u8); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

// ---------------------------------------------------------------- state
const S = {
  info: null, arctium: null, profile: null, casc: null,
  pathById: new Map(), idByPath: new Map(), dirIndex: new Map(),
  customMap: new Map(), customPaths: new Map(), mappingIssues: [],
  sources: [], // {abs, name, enabled, files: Map(lc -> {rel,size}), unknown: [] }
  texCache: new Map(),
};
window.S = S; // for troubleshooting from the browser console
const GAME_TOP = new Set(["character", "creature", "item", "world", "spells", "environments", "models", "textures", "interface", "sound", "dungeons", "particles", "cameras", "tileset", "dbfilesclient", "fonts", "xtextures"]);

// ---------------------------------------------------------------- startup
async function start() {
  busy("Connecting to the helper...");
  S.info = await (await api("/api/info")).json();
  S.arctium = JSON.parse(await apiText("/api/config"));
  busy("Opening game data...");
  const wow = S.info.wowRoot;
  const io = {
    read: (rel, o, n) => o === undefined ? readAbs(winJoin(wow, rel)) : apiBytes("/api/read", { p: winJoin(wow, rel), o, n }),
    readText: (rel) => apiText("/api/read", { p: winJoin(wow, rel) }),
    list: async (rel) => (await apiText("/api/ls", { p: winJoin(wow, rel) })).split("\n").filter((l) => l.startsWith("F\t")).map((l) => l.split("\t")[1]),
    inflate,
  };
  S.casc = await new Casc(io, S.info.product).open((t) => busy(t));
  busy("Reading the game's file list (takes a few seconds)...");
  await loadListfile();
  busy("Scanning your mod folders...");
  await loadProfile();
  const moved = await migrateMoved();
  await scanSources();
  if (moved) await fixMovedRefs(moved);
  await loadMappings();
  if (S.firstRun) { try { await saveProfile(); } catch {} }
  busy(null);
  status(`Game ${S.casc.version} · ${S.sources.filter((s) => s.enabled).length} of ${S.sources.length} mod folders on`);
  initViews();
  renderModelList();
  // the customization tables also tell which creature models are really playable races (Skyborne ...): list them once read
  loadCreatureTables().then(loadChr).then(() => renderModelList()).catch((e) => console.warn("chr tables", e));
  // gear list is built when the Gear tab opens (it reads the item tables)
  renderOrderPage();
}

async function loadListfile() {
  const txt = await apiText("/api/read", { p: "FILEMAPPING" });
  let p = 0;
  const n = txt.length;
  while (p < n) {
    let e = txt.indexOf("\n", p); if (e < 0) e = n;
    const semi = txt.indexOf(";", p);
    if (semi > p && semi < e) {
      let end = e; if (txt.charCodeAt(end - 1) === 13) end--;
      const c = txt.charCodeAt(end - 1);
      // keep model-related files only: .m2 .skin .blp .anim .bone .skel .phys
      if (c === 50 || c === 110 || c === 112 || c === 109 || c === 101 || c === 108 || c === 115) {
        const path = txt.slice(semi + 1, end).toLowerCase();
        if (/\.(m2|skin|blp|anim|bone|skel|phys)$/.test(path)) {
          const fid = +txt.slice(p, semi);
          S.pathById.set(fid, path); S.idByPath.set(path, fid);
        }
      }
    }
    p = e + 1;
  }
  for (const path of S.idByPath.keys()) {
    if (!/\.(m2|skin|blp)$/.test(path)) continue;
    const d = dirname(path);
    let a = S.dirIndex.get(d); if (!a) S.dirIndex.set(d, (a = []));
    a.push(path);
  }
}

// ---------------------------------------------------------------- profile + sources
const profilePath = () => winJoin(S.info.appDir, "profile.json");
async function loadProfile() {
  try { S.profile = JSON.parse(await apiText("/api/read", { p: profilePath() })); }
  catch { S.profile = null; }
  if (!S.profile) {
    // first run: import enabled/order from the Arctium app
    const folders = [];
    for (const grp of Object.values(S.arctium.Mods.Folders || {})) for (const f of Object.values(grp)) folders.push(f);
    folders.sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0));
    const maps = [];
    for (const grp of Object.values(S.arctium.Mods.Mappings || {})) for (const m of Object.values(grp)) if (!m.IsInternal && m.IsEnabled) maps.push(m.Path);
    S.profile = { version: 1, sources: folders.map((f) => ({ path: f.Path, enabled: !!f.IsEnabled })), picks: {}, extraMappings: maps, imported: true };
    S.firstRun = true;
  }
  S.profile.presets ||= {}; S.profile.lastPreset ||= {};
  S.profile.picks ||= {}; S.profile.extraMappings ||= []; S.profile.remap ||= {}; S.profile.hair ||= {};
}
async function saveProfile() {
  S.profile.sources = S.sources.map((s) => ({ path: s.key, enabled: s.enabled }));
  await api("/api/write", { p: profilePath() }, { method: "POST", body: JSON.stringify(S.profile, null, 1) });
}

// ---------------------------------------------------------------- moved mod folders
// When mods are reorganized, <mods root>\_reorg_map.json lists where each old folder went. Saved paths in profile.json
// (load order, picks, hair, swaps, presets) are rewritten to the new places. One old folder can have several new ones.
const normP = (p) => String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
// _reorg_map.json: { ops: [[src, dst, note], ...] } with src relative to the OLD mods root and dst relative to the new one.
// note: "whole", "race-split" (one old folder split into several), "pack:<set>" (merged into a pack), "loose file", "archive".
// Absolute paths ({from,to} objects or [from,to]) work too.
async function readMoveMap() {
  let j; try { j = JSON.parse((await apiText("/api/read", { p: winJoin(S.info.modsRoot, "_reorg_map.json") })).replace(/^\uFEFF/, "")); } catch (e) { console.warn("reorg map", e); return null; }
  const ops = (Array.isArray(j) ? j : j.ops || []).map((o) => Array.isArray(o) ? o : [o.from ?? o.src ?? o.source, o.to ?? o.dst ?? o.dest, o.note || ""]).filter((o) => typeof o[0] === "string" && typeof o[1] === "string");
  const abs = (v) => /^[a-z]:[\\/]|^\\\\/i.test(v);
  const clean = (v) => v.replace(/\//g, "\\").replace(/\\+$/, "");
  // the old root isn't stored anywhere: find the folder that, joined with the ops' sources, gives the saved paths
  const saved = S.profile.sources.map((x) => normP(x.path.split("#")[0]));
  const votes = new Map();
  for (const [src] of ops) { if (abs(src)) continue; const sn = "\\" + normP(src); for (const p of saved) if (p.endsWith(sn)) { const r = p.slice(0, p.length - sn.length); votes.set(r, (votes.get(r) || 0) + 1); } }
  const oldRoot = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const pairs = [];
  for (const [src, dst, note] of ops) {
    if (/^(archive|loose)/i.test(note || "")) continue;
    const from = abs(src) ? normP(src) : oldRoot ? oldRoot + "\\" + normP(src) : null;
    if (!from) continue;
    // new Arctium mod folder = Models|Skins\<Race>\<Author>\<Mod>, otherwise <Category>\<Author>\<Mod>
    const parts = clean(dst).split("\\");
    const rel = abs(dst) ? null : parts.slice(0, /^(models|skins)$/i.test(parts[0]) ? 4 : 3).join("\\");
    const to = rel ? winJoin(S.info.modsRoot, rel) : clean(dst);
    pairs.push([from, to, note || "", rel && parts.length > rel.split("\\").length]);
  }
  return pairs;
}
function movedTargets(pairs, path) {
  const [base, ...v] = String(path).split("#"), suffix = v.length ? "#" + v.join("#") : "", b = normP(base);
  const out = [];
  for (const [from, to, note, trimmed] of pairs) {
    if (b === from) out.push(to + suffix);
    else if (b.startsWith(from + "\\")) out.push(trimmed ? to + suffix : to + clean2(base).slice(from.length) + suffix);
    // the saved folder was the mod root and its game folders went elsewhere (a pack split per race, Tauri\Item ...)
    else if (from.startsWith(b + "\\") && !suffix && GAME_TOP.has(from.slice(b.length + 1).split("\\")[0])) out.push(to);
  }
  return [...new Set(out)];
}
const clean2 = (v) => v.replace(/\//g, "\\").replace(/\\+$/, "");
async function migrateMoved() {
  const outside = S.profile.sources.filter((s) => !normP(s.path).startsWith(normP(S.info.modsRoot) + "\\"));
  if (!outside.length) return null;
  const pairs = await readMoveMap(); if (!pairs || !pairs.length) return null;
  try { await api("/api/write", { p: winJoin(S.info.appDir, "backups\\profile-before-move.json") }, { method: "POST", body: JSON.stringify(S.profile, null, 1) }); } catch {}
  const map = new Map(), out = [], seen = new Set();
  for (const s of S.profile.sources) {
    const t = normP(s.path).startsWith(normP(S.info.modsRoot) + "\\") ? [] : movedTargets(pairs, s.path);
    if (t.length) map.set(s.path.toLowerCase(), t);
    for (const p of t.length ? t : [s.path]) if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); out.push({ path: p, enabled: s.enabled }); }
  }
  if (!map.size) return null;
  S.profile.sources = out;
  S.profile.movedFrom = Object.fromEntries(map);
  // written directly: saveProfile() takes the order from S.sources, which isn't scanned yet
  await api("/api/write", { p: profilePath() }, { method: "POST", body: JSON.stringify(S.profile, null, 1) });
  return map;
}
// picks / hair / swaps / presets name a source by key: use the new folder that actually has the file
async function fixMovedRefs(map) {
  const fix = (key, lc) => {
    if (!key || key === "@game") return key;
    const t = map.get(key.toLowerCase()); if (!t) return key;
    const srcs = t.map((k) => S.sources.find((x) => x.key.toLowerCase() === k.toLowerCase())).filter(Boolean);
    const hit = (lc && srcs.find((x) => x.files.has(lc))) || srcs[0];
    return hit ? hit.key : t[0];
  };
  const P = S.profile;
  for (const lc of Object.keys(P.picks)) P.picks[lc] = fix(P.picks[lc], lc);
  for (const [lc, r] of Object.entries(P.remap || {})) r.src = fix(r.src, r.lc);
  for (const [lc, cfg] of Object.entries(P.hair || {})) for (const c of Object.values(cfg)) c.src = fix(c.src, lc);
  for (const byName of Object.values(P.presets || {})) for (const pr of Object.values(byName)) for (const o of pr.overlays || []) o.src = o.src && fix(o.src, o.lc);
  await saveProfile();
}

function findRoot(segs) {
  // returns index where the game path starts
  for (let i = 0; i < segs.length - 1; i++) {
    if (S.idByPath.has(segs.slice(i).join("/").toLowerCase())) return i;
  }
  for (let i = 0; i < segs.length - 1; i++) if (GAME_TOP.has(segs[i].toLowerCase())) return i;
  return -1;
}

async function scanTree(abs) {
  const txt = await apiText("/api/tree", { p: abs });
  return txt.split("\n").filter(Boolean).map((l) => { const [rel, size] = l.split("\t"); return { rel, size: +size }; });
}

async function scanSources() {
  const roots = new Map(); // abs(lower) -> {abs, files}
  const addFile = (rootAbs, rel, size) => {
    const k = rootAbs.toLowerCase();
    let r = roots.get(k); if (!r) roots.set(k, (r = { abs: rootAbs, files: new Map(), unknown: [] }));
    const lc = rel.toLowerCase();
    if (/\.(txt|png|rar|zip|7z|json|db|ini|md|jpg)$/i.test(lc) || /(^|\/)thumbs\.db$/.test(lc)) { r.unknown.push(rel); if (lc.endsWith(".txt")) (r.txts ||= []).push(rel); return; }
    // some packs leave out the leading "models/" (creature/unk_exp00_.../x.blp): put them where the game expects them
    const fixed = !S.idByPath.has(lc) && S.idByPath.has("models/" + lc) ? "models/" + lc : lc;
    r.files.set(fixed, { rel, size });
  };
  const scanUnder = async (base) => {
    const files = (await scanTree(base)).map((f) => ({ ...f, segs: f.rel.split("/") })).filter((f) => !f.segs[0].startsWith("_")); // _Archives ... are not loaded
    // pass 1: files whose path ends in a known game path fix where their mod folder starts
    const known = (segs) => { for (let i = 0; i < segs.length - 1; i++) if (S.idByPath.has(segs.slice(i).join("/").toLowerCase())) return i; return -1; };
    const roots = new Set();
    for (const f of files) { f.i = known(f.segs); if (f.i >= 0) roots.add(f.segs.slice(0, f.i).join("/").toLowerCase()); }
    const byLen = [...roots].sort((a, b) => b.length - a.length);
    // pass 2: other files belong to the mod folder they sit in (so a "Models" category folder isn't taken for the game's models folder)
    for (const f of files) {
      let i = f.i;
      if (i < 0) {
        const lc = f.rel.toLowerCase();
        const r = byLen.find((x) => x === "" ? false : lc.startsWith(x + "/"));
        if (r !== undefined) i = r.split("/").length;
        else if (!/\.txt$/i.test(f.rel)) i = findRoot(f.segs);
        else { const j = f.segs.findIndex((x) => GAME_TOP.has(x.toLowerCase())); i = j; }
      }
      if (i < 0 || i >= f.segs.length) continue;
      const rootAbs = i === 0 ? base : winJoin(base, f.segs.slice(0, i).join("/"));
      addFile(rootAbs, f.segs.slice(i).join("/"), f.size);
    }
  };
  await scanUnder(S.info.modsRoot);
  // profile sources outside the mods root
  for (const s of S.profile.sources) if (!s.path.toLowerCase().startsWith(S.info.modsRoot.toLowerCase())) { try { await scanUnder(s.path); } catch {} }

  // alternate versions shipped in sub folders (e.g. creature/alleria/topless/alleria.m2 -> creature/alleria/alleria.m2)
  const variants = [];
  for (const r of roots.values()) {
    const vmap = new Map();
    for (const [lc, f] of r.files) {
      if (S.idByPath.has(lc)) continue;
      const segs = lc.split("/");
      if (segs.length < 3) continue;
      const target = [...segs.slice(0, -2), segs[segs.length - 1]].join("/");
      if (!S.idByPath.has(target) && !r.files.has(target)) continue;
      const vdir = segs.slice(0, -1).join("/");
      let v = vmap.get(vdir); if (!v) vmap.set(vdir, (v = new Map()));
      v.set(target, f);
    }
    for (const [vdir, files] of vmap) {
      for (const lc of [...r.files.keys()]) if (lc.startsWith(vdir + "/")) r.files.delete(lc);
      variants.push({ parent: r, vdir, files });
    }
  }
  for (const r of roots.values()) r.key = r.abs;
  const byKey = new Map([...roots.values()].map((r) => [r.abs.toLowerCase(), r]));
  for (const v of variants) {
    const key = v.parent.abs + "#" + v.vdir;
    byKey.set(key.toLowerCase(), { abs: v.parent.abs, key, files: v.files, unknown: [], variantOf: v.parent.abs, vname: v.vdir.split("/").slice(-2).join("/") });
  }
  const out = [];
  const seen = new Set();
  const mk = (r, enabled, extra = {}) => ({ ...r, name: r.vname ? srcName(r.abs) + " › " + r.vname : srcName(r.abs), enabled, ...extra });
  for (const s of S.profile.sources) {
    const k = s.path.toLowerCase().replace(/[\\/]+$/, "");
    const r = byKey.get(k);
    if (seen.has(k)) continue; seen.add(k);
    if (!r) {
      // folders like "Goon\\Titaa" that only hold other mod folders have no game files of their own
      if (k.startsWith(S.info.modsRoot.toLowerCase())) continue;
      out.push({ abs: s.path, key: s.path, name: srcName(s.path), enabled: s.enabled, files: new Map(), unknown: [], missing: true }); continue;
    }
    out.push(mk(r, s.enabled));
  }
  for (const [k, r] of byKey) if (!seen.has(k)) {
    const item = mk(r, false, { isNew: true });
    // place a new alternate version right above its parent so turning it on makes it win
    const pi = r.variantOf ? out.findIndex((x) => x.key === r.variantOf) : -1;
    if (pi >= 0) out.splice(pi, 0, item); else out.push(item);
  }
  S.sources = out;
}
function srcName(abs) {
  const v = abs.indexOf("#");
  if (v > 0) { const src = S.sources.find((x) => x.key.toLowerCase() === abs.toLowerCase()); if (src) return src.name; abs = abs.slice(0, v); }
  const base = S.info.modsRoot.replace(/[\\/]+$/, "");
  return abs.toLowerCase().startsWith(base.toLowerCase() + "\\") ? abs.slice(base.length + 1) : abs;
}

// ---------------------------------------------------------------- mappings (custom file IDs)
async function loadMappings() {
  S.customMap = new Map(); S.customPaths = new Map(); S.mappingLines = []; S.mappingConflicts = [];
  const add = (fid, path, origin) => {
    path = path.trim().replace(/\\/g, "/").toLowerCase();
    if (!fid || !path) return;
    const old = S.customMap.get(fid);
    if (old && old.path !== path) { S.mappingConflicts.push({ fid, kept: old, dropped: { path, origin } }); return; }
    if (old) return;
    S.customMap.set(fid, { path, origin }); S.customPaths.set(path, fid);
  };
  const parse = (txt, origin) => { for (const l of txt.split(/\r?\n/)) { const m = /^\s*(\d+)\s*;\s*(.+?)\s*$/.exec(l); if (m) add(+m[1], m[2], origin); } };
  // ours first (fixes), then extra mapping files, then .txt files shipped inside enabled mod folders
  try { parse(await apiText("/api/read", { p: winJoin(S.info.appDir, "extra-mappings.txt") }), "Arctium Mod Manager fixes"); } catch {}
  for (const p of S.profile.extraMappings) { try { parse(await apiText("/api/read", { p }), basename(p.replace(/\\/g, "/"))); } catch (e) { S.mappingIssues.push("Could not read mapping file " + p); } }
  for (const s of S.sources) if (s.enabled) for (const rel of s.txts || []) { try { parse(await apiText("/api/read", { p: winJoin(s.abs, rel) }), s.name + " / " + basename(rel)); } catch {} }
  // switched-off mods too, so their previews find their textures (the build only writes IDs of files it ships; enabled mods win on duplicates)
  const nConf = S.mappingConflicts.length;
  for (const s of S.sources) if (!s.enabled) for (const rel of s.txts || []) { try { parse(await apiText("/api/read", { p: winJoin(s.abs, rel) }), s.name + " / " + basename(rel)); } catch {} }
  S.mappingConflicts.length = nConf;
}

// ---------------------------------------------------------------- file resolution
// mode: "build" (load order + picks), "game", or a source object (that mod, then the game)
// A view can take the model from one source and the skins (textures) from another: mode = { mix: true, model, tex }
const isTexLC = (lc) => lc.endsWith(".blp");
const pickMode = (lc, mode) => (mode && mode.mix ? (isTexLC(lc) ? mode.tex : mode.model) : mode);
const texMode = (mode) => (mode && mode.mix ? mode.tex : mode);
const modelMode = (mode) => (mode && mode.mix ? mode.model : mode);
function sourceFor(lc, mode) {
  mode = pickMode(lc, mode);
  if (mode === "game") return null;
  if (mode && mode.files) return mode.files.has(lc) ? mode : null;
  const pick = S.profile.picks[lc];
  if (pick === "@game") return null;
  if (pick) { const s = S.sources.find((x) => x.key.toLowerCase() === pick.toLowerCase()); if (s && s.files.has(lc)) return s; }
  for (const s of S.sources) if (s.enabled && s.files.has(lc)) return s;
  return null;
}
function isGamePath(lc) { return S.idByPath.has(lc) || S.customPaths.has(lc); }
// "Use another texture": profile.remap[targetLc] = { lc: sourceLc, src: sourceKey | "@game" } — the build writes that file under the target's name
const remapOf = (lc, mode) => (pickMode(lc, mode) === "build" && ((cur.swapPreview && cur.swapPreview[lc]) || (S.profile.remap && S.profile.remap[lc]))) || null;
async function readRemap(r) {
  if (r.src === "@game") return S.casc.readFid(S.idByPath.get(r.lc));
  const s = S.sources.find((x) => x.key.toLowerCase() === r.src.toLowerCase());
  if (!s || !s.files.has(r.lc)) throw new Error("replacement texture is gone: " + r.lc);
  return readAbs(winJoin(s.abs, s.files.get(r.lc).rel));
}
async function readLC(lc, mode) {
  const rm = remapOf(lc, mode); if (rm) return readRemap(rm);
  const s = sourceFor(lc, mode);
  if (s) return readAbs(winJoin(s.abs, s.files.get(lc).rel));
  const fid = S.idByPath.get(lc);
  if (fid !== undefined && S.casc.has(fid)) return S.casc.readFid(fid);
  throw new Error("not found: " + lc);
}
function lcForFid(fid) { return S.customMap.get(fid)?.path || S.pathById.get(fid); }
async function readFid(fid, mode) {
  const lc = lcForFid(fid);
  if (lc) { try { return await readLC(lc, mode); } catch (e) { if (!S.casc.has(fid)) throw e; } }
  return S.casc.readFid(fid);
}
async function loadImg(key, loader) {
  if (S.texCache.has(key)) return S.texCache.get(key);
  const p = loader().then((b) => decodeBLP(b, 2048));
  S.texCache.set(key, p);
  p.catch(() => S.texCache.delete(key));
  if (S.texCache.size > 300) S.texCache.delete(S.texCache.keys().next().value);
  return p;
}
const modeKey = (mode) => (mode === "game" ? "game" : mode === "build" ? "build" : "src:" + mode.key);
const imgLC = (lc, mode) => { const rm = remapOf(lc, mode); if (rm) return loadImg("remap|" + rm.src + "|" + rm.lc, () => readRemap(rm)); const s = sourceFor(lc, mode); return loadImg((s ? s.key : "game") + "|" + lc, () => readLC(lc, mode)); };

function sourcesTouching(lcs) {
  const set = new Set(lcs);
  return S.sources.filter((s) => { for (const lc of set) if (s.files.has(lc)) return true; return false; });
}

// ---------------------------------------------------------------- 3D views
let V; // Viewer
const cur = { entry: null, modelLC: null, modelA: null, slots: {}, geo: null, overlays: [], char: null, framed: false, hasModel: false };
function initViews() {
  V = new Viewer([$("#cA"), $("#cB")]);
  V.setBackground("#191b21");
  $("#srcA").onchange = () => refresh();
  $("#srcB").onchange = () => refresh();
  // choosing a model or skin on the left puts it straight into your build
  for (const id of ["#srcA", "#texA"]) $(id).onchange = async () => { await saveViewSel(); await useViewInBuild(); refresh(); };
  $("#srcB").onchange = async () => { await saveViewSel(); refresh(); };
}
// the view dropdowns are remembered per model: profile.view[entry key] = { srcA, texA, srcB }
async function saveViewSel() {
  if (!cur.entry) return;
  (S.profile.view ||= {})[cur.entry.key] = { srcA: $("#srcA").value, texA: $("#texA").value, srcB: $("#srcB").value };
  await saveProfile();
}
// The left view's model and skins become per-file picks, so Build produces what the left view shows
async function useViewInBuild() {
  if (!cur.entry || !cur.viewFiles) return;
  const m = $("#srcA").value, t = $("#texA").style.display === "none" ? m : ($("#texA").value === "same" ? m : $("#texA").value);
  const src = (v) => (v === "game" ? "@game" : v === "build" ? undefined : S.sources.find((x) => x.key === v));
  const { mdl, texPrefix, lcs } = cur.viewFiles;
  const texFiles = new Set(lcs.filter(isTexLC));
  if (texPrefix) for (const x of S.sources) for (const lc of x.files.keys()) if (isTexLC(lc) && [].concat(texPrefix).some((p) => lc.startsWith(p + "/"))) texFiles.add(lc);
  const ms = src(m), ts = src(t);
  if (ms === undefined && ts === undefined) return;
  let n = 0;
  const pick = (lc, s) => { if (s === undefined) return; if (s === "@game") { if (S.idByPath.has(lc)) { setPick(lc, "@game"); n++; } } else if (s.files.has(lc)) { setPick(lc, s.key); n++; } else if (S.profile.picks[lc] && !isTexLC(lc)) { setPick(lc, null); } };
  for (const lc of mdl) pick(lc, ms);
  for (const lc of texFiles) pick(lc, ts);
  await saveProfile();
  S.gearCache = null; mixCache = null;
  status(`Your build now uses this (${n} files). Press Build on the Load order tab to put it in game.`);
}
function selMode(v) {
  if (v === "build" || v === "game") return v;
  return S.sources.find((s) => s.key === v) || "build";
}
// view i: model dropdown + skin dropdown ("same" = skins come from the same choice as the model)
function modeFromSelect(sel) {
  const model = selMode(sel.value);
  const t = $(sel.id === "srcA" ? "#texA" : "#texB");
  if (!t || t.style.display === "none" || !t.value || t.value === "same" || t.value === sel.value) return model;
  return { mix: true, model, tex: selMode(t.value), key: sel.value + "+" + t.value };
}
// Model dropdown: mods that ship the model files. Skin dropdown: mods that ship textures for this model.
function fillSourceSelects(lcs, texPrefix) {
  const prefixes = texPrefix ? [].concat(texPrefix) : null;
  const mdl = lcs.filter((lc) => !isTexLC(lc));
  const modelSrc = sourcesTouching(mdl);
  const texSrc = S.sources.filter((s) => {
    for (const lc of s.files.keys()) if (isTexLC(lc) && (prefixes ? prefixes.some((x) => lc.startsWith(x + "/")) : lcs.includes(lc))) return true;
    return false;
  });
  const hasModel = mdl.some((lc) => lc.endsWith(".m2"));
  const opt = (s) => el("option", { value: s.key }, "Mod: " + s.name + (s.enabled ? "" : " (off)"));
  cur.viewFiles = { mdl, texPrefix, lcs };
  const saved = (S.profile.view || {})[cur.entry?.key] || {};
  for (const [id, tid, def] of [["#srcA", "#texA", "build"], ["#srcB", "#texB", "game"]]) {
    const sel = $(id), prev = sel.value, tsel = $(tid), tprev = tsel.value;
    sel.innerHTML = ""; tsel.innerHTML = "";
    sel.append(el("option", { value: "build" }, (hasModel ? "Model: " : "") + "Your build (load order + picks)"));
    sel.append(el("option", { value: "game" }, (hasModel ? "Model: " : "") + "Original game"));
    for (const s of hasModel ? modelSrc : texSrc) sel.append(opt(s));
    tsel.append(el("option", { value: "same" }, "Skins: same as model"));
    tsel.append(el("option", { value: "build" }, "Skins: your build"));
    tsel.append(el("option", { value: "game" }, "Skins: original game"));
    for (const s of texSrc) tsel.append(el("option", { value: s.key }, "Skins: " + s.name + (s.enabled ? "" : " (off)")));
    tsel.style.display = hasModel && id === "#srcA" ? "" : "none"; // skins are picked for the left view only; the right stays a plain comparison
    const has = (x, v) => v && [...x.options].some((o) => o.value === v);
    const want = id === "#srcA" ? saved.srcA : saved.srcB, twant = id === "#srcA" ? saved.texA : null;
    sel.value = has(sel, want) ? want : has(sel, prev) && cur.keepSel ? prev : def;
    tsel.value = has(tsel, twant) ? twant : has(tsel, tprev) && cur.keepSel ? tprev : "same";
  }
}

// ---------------------------------------------------------------- model list
const CUSTOM_RACES = { 7478494: "skyborne female" };
// races whose in-game body is a creature-path model but whose mods also ship the blood elf files: shown as one entry
const RACE_MERGE = { 7478494: "character/bloodelf/female" };
const entryDirs = (e) => e.dirs || [e.dir];
function entryFiles(e) { const set = new Set(); for (const d of entryDirs(e)) for (const x of dirFiles(d)) set.add(x); return set; }
function modelEntries() {
  const onlyModded = $("#mOnlyModded").checked;
  const entries = new Map(); // key -> {key, group, label, dir, models:Set}
  const add = (group, dir, label, m2) => {
    const key = group + "|" + dir;
    let e = entries.get(key); if (!e) entries.set(key, (e = { key, group, dir, label, models: new Set(), modded: false }));
    if (m2) e.models.add(m2);
    return e;
  };
  // playable characters: always listed
  for (const p of S.idByPath.keys()) {
    const m = /^character\/([a-z]+)\/(male|female)\/\1\2(_hd)?\.m2$/.exec(p);
    if (m && S.casc.has(S.idByPath.get(p))) add("Playable characters", dirname(p), `${m[1]} ${m[2]}`, p);
  }
  // custom playable races whose body is stored as a creature model (e.g. Skyborne = models/creature/unk_exp00_7478494)
  if (CHR) for (const fid of CHR.byModelFid.keys()) {
    const p = S.pathById.get(fid);
    // ChrModel also covers customizable pets and forms (felguard, imp, druid forms): those stay creatures
    if (!p || p.startsWith("character/") || p.startsWith("creature/") || !S.casc.has(fid)) continue;
    add("Playable characters", dirname(p), CUSTOM_RACES[fid] || "custom race " + basename(p).replace(/\.m2$/, ""), p);
  }
  // everything any mod touches
  for (const s of S.sources) for (const lc of s.files.keys()) {
    const dir = dirname(lc);
    const top = lc.split("/")[0];
    const pe = entries.get("Playable characters|" + dir);
    if (pe) { pe.modded = true; continue; }
    if (top === "character") continue;
    if (lc.startsWith("item/texturecomponents/")) continue; // gear textures: Gear tab
    const group = top === "item" ? "Item models" : "Creatures & NPCs";
    const e = add(group, dir, dir.replace(/^(creature|item\/objectcomponents|models)\//, ""), null);
    e.modded = true;
    if (lc.endsWith(".m2")) e.models.add(lc);
  }
  for (const e of entries.values()) {
    if (!e.models.size) for (const p of S.dirIndex.get(e.dir) || []) if (p.endsWith(".m2")) e.models.add(p);
  }
  for (const [fid, other] of Object.entries(RACE_MERGE)) {
    const p = S.pathById.get(+fid); if (!p) continue;
    const a = entries.get("Playable characters|" + dirname(p)), b = entries.get("Playable characters|" + other);
    if (!a || !b) continue;
    a.dirs = [a.dir, b.dir]; a.primary = p; a.label += " (blood elf)";
    for (const m of b.models) a.models.add(m);
    a.modded ||= b.modded;
    entries.delete(b.key);
  }
  let list = [...entries.values()];
  if (onlyModded) list = list.filter((e) => e.modded);
  return list;
}
function renderModelList() {
  const q = $("#mSearch").value.trim().toLowerCase();
  const list = modelEntries().filter((e) => !q || (e.label + " " + e.dir).toLowerCase().includes(q));
  const box = $("#mList"); box.innerHTML = "";
  const groups = ["Playable characters", "Creatures & NPCs", "Item models"];
  for (const g of groups) {
    const items = list.filter((e) => e.group === g).sort((a, b) => a.label.localeCompare(b.label));
    if (!items.length) continue;
    box.append(el("div", { class: "grp" }, `${g} (${items.length})`));
    for (const e of items) {
      const n = sourcesTouching([...entryFiles(e)]).length;
      const it = el("div", { class: "it" + (cur.entry && cur.entry.key === e.key ? " on" : ""), onclick: () => { cur.keepSel = false; selectEntry(e); renderModelList(); } },
        e.label, e.modded ? el("small", {}, n + (n === 1 ? " mod" : " mods")) : el("small", {}, "vanilla"));
      box.append(it);
    }
  }
}
$("#mSearch").oninput = () => renderModelList();
$("#mOnlyModded").onchange = () => renderModelList();

function dirFiles(dir) {
  const set = new Set(S.dirIndex.get(dir) || []);
  for (const s of S.sources) for (const lc of s.files.keys()) if (dirname(lc) === dir) set.add(lc);
  for (const p of S.customPaths.keys()) if (dirname(p) === dir) set.add(p);
  return set;
}

async function selectEntry(e) {
  cur.entry = e; cur.framed = false; cur.slots = {}; cur.geo = null; cur.inited = false; cur.texLC = null;
  const models = [...e.models].sort((a, b) => (b === e.primary) - (a === e.primary) || (b.includes("_hd") - a.includes("_hd")) || a.localeCompare(b));
  cur.modelLC = models[0] || null;
  cur.char = /^character\//.test(e.dir) ? parseCharDir(e.dir, cur.modelLC) : null;
  cur.variations = []; cur.variation = null;
  cur.cm = null; cur.custom = null;
  try {
    busy("Reading game tables..."); await loadCreatureTables();
    if (cur.char || e.group === "Playable characters") await loadChr();
    // custom race stored as a creature model: treat it as a character (customization options, skins)
    if (!cur.char && e.group === "Playable characters") cur.char = { race: e.label.split(" ")[0], sex: e.label.split(" ")[1] || "", hd: true, custom: true };
  } catch (err) { console.warn(err); }
  busy(null);
  if (!cur.char) cur.overlays = [];
  fillSourceSelects([...entryFiles(e)], cur.char ? entryDirs(e) : null);
  await refresh(true);
}
function parseCharDir(dir, modelLC) {
  const m = /^character\/([a-z]+)\/(male|female)$/.exec(dir);
  return m ? { race: m[1], sex: m[2], hd: !!(modelLC && modelLC.includes("_hd")) } : null;
}

// --- playable characters: customization tables
let CHR = null;
async function loadChr() { if (!CHR) CHR = await new ChrData().load((f) => S.casc.readFid(f), CR); return CHR; }
const imgFid = (fid, mode) => { const s = sourceFor(lcForFid(fid) || "", mode); return loadImg((s ? s.key : "game") + "|fid" + fid, () => readFid(fid, mode)); };
function applyCustomGeo() {
  if (!cur.cm || !cur.geo) return;
  const res = CHR.resolve(cur.cm, cur.custom);
  for (const g of res.geosets) {
    const want = g.type * 100 + g.id;
    for (const id of cur.geo.ids) if (Math.floor(id / 100) === g.type && (g.type !== 0 || id !== 0)) cur.geo.on.delete(id);
    if (cur.geo.ids.includes(want)) cur.geo.on.add(want);
    if (g.type === 0 && g.id > 0) cur.hairBase = want;
  }
}
// Hair styles (parts 1-99): the left view shows the style picked in the hair panel, the right view keeps the
// style from the character options, so trying hairstyles on your body never changes the comparison side.
const isHairId = (id) => id > 0 && id < 100;
function geoOn(side, id) {
  if (side === 1 && isHairId(id) && cur.hairBase != null && cur.geo.ids.includes(cur.hairBase)) return id === cur.hairBase;
  return cur.geo.on.has(id);
}
async function composeChr(type, mode) {
  const res = CHR.resolve(cur.cm, cur.custom);
  const skinOpt = CHR.options(cur.cm).find((o) => /skin/i.test(o.name))?.id;
  const isUnder = (l) => l.opt === skinOpt && (l.mask === 8 || l.mask === 32);
  const c = await paintType(res, type, (fid) => imgFid(fid, mode), {
    skip: cur.slots.underwear === false ? isUnder : null,
    after: type !== 1 ? null : async (g, rect) => {
      const order = [5, 6, 7, 3, 4, 0, 1, 2];
      for (const sec of order) for (const o of cur.overlays.filter((x) => x.section === sec)) {
        const m = texMode(mode) === "game" ? "game" : o.src ? o.src : texMode(mode);
        const r = rect(sec); if (!r) continue;
        try { g.drawImage(imgToCanvas(await imgLC(o.lc, m)), r[0], r[1], r[2], r[3]); } catch {}
      }
    },
  });
  return c ? canvasTexture(c) : null;
}

// --- creature texture variations (CreatureDisplayInfo)
const CR = { loaded: false };
async function loadCreatureTables() {
  if (CR.loaded) return;
  const [cdi, cmd] = await Promise.all([1108759, 1365368].map(async (f) => new DB2(await S.casc.readFid(f))));
  CR.modelByFid = new Map(); CR.modelFid = new Map(); CR.dispModel = new Map();
  for (const r of cdi.rows) CR.dispModel.set(r.id, r.v[1]);
  for (const r of cmd.rows) { const fid = r.v[2]; CR.modelFid.set(r.id, fid); if (!CR.modelByFid.has(fid)) CR.modelByFid.set(fid, []); CR.modelByFid.get(fid).push(r.id); }
  CR.disp = new Map();
  for (const r of cdi.rows) { const mid = r.v[1], tex = r.v[r.v.length - 1]; if (!Array.isArray(tex)) continue; if (!CR.disp.has(mid)) CR.disp.set(mid, []); CR.disp.get(mid).push({ id: r.id, tex }); }
  CR.loaded = true;
}
function variationsFor(modelLC) {
  if (!CR.loaded) return [];
  const fid = S.idByPath.get(modelLC);
  const out = new Map();
  for (const mid of CR.modelByFid.get(fid) || []) for (const d of CR.disp.get(mid) || []) {
    const paths = d.tex.slice(0, 3).map((f) => (f ? lcForFid(f) || null : null));
    if (!paths.some(Boolean)) continue;
    const key = paths.join("|");
    if (!out.has(key)) out.set(key, { key, paths, displays: [] });
    out.get(key).displays.push(d.id);
  }
  return [...out.values()];
}

// --- texture slots
function texCandidates(dir) { return [...dirFiles(dir)].filter((p) => p.endsWith(".blp")).sort(); }
function charOptions(dir, hd) {
  const files = texCandidates(dir);
  const sfx = hd ? "_hd" : "";
  const skins = new Set(), faces = new Set();
  for (const f of files) {
    let m = new RegExp(`skin00_(\\d+)${sfx}\\.blp$`).exec(f); if (m && !/naked/.test(f) && !/extra/.test(f)) skins.add(m[1]);
    m = new RegExp(`face(?:lower|upper)(\\d+)_\\d+${sfx}\\.blp$`).exec(f); if (m) faces.add(m[1]);
  }
  return { files, skins: [...skins].sort(), faces: [...faces].sort(), hair: files.filter((f) => /hair/.test(f) && (!hd || f.includes("_hd"))) };
}
function defaultSlots(model, dir) {
  const slots = {};
  const files = texCandidates(dir);
  if (cur.char) {
    const o = charOptions(dir, cur.char.hd);
    slots.skin = o.skins.includes("00") ? "00" : o.skins[0];
    slots.face = o.faces[0] || null;
    slots.underwear = true;
    slots[6] = o.hair[0] || null;
  }
  const want = new Set(model.textures.map((t) => t.type).filter((t) => t !== 0 && t !== 1));
  const base = basename(dir);
  if (cur.forcedSlots) { Object.assign(slots, cur.forcedSlots); cur.forcedSlots = null; }
  if (!cur.char) {
    cur.variations = variationsFor(cur.modelLC);
    if (cur.variations.length) { const v = cur.variations[0]; slots[11] = v.paths[0]; slots[12] = v.paths[1]; slots[13] = v.paths[2]; cur.variation = v.key; }
  }
  for (const t of want) {
    if (slots[t] !== undefined) continue;
    const pref = files.filter((f) => /skin/.test(basename(f))).concat(files.filter((f) => basename(f).startsWith(base)));
    slots[t] = (t === 11 ? (pref[0] || files[0]) : null) || null;
  }
  return slots;
}

// --- geosets
function defaultGeo(skin) {
  const ids = [...new Set(skin.submeshes.map((s) => s.id))].sort((a, b) => a - b);
  const on = new Set();
  const groups = new Map();
  for (const id of ids) { const g = Math.floor(id / 100); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(id); }
  for (const [g, list] of groups) {
    if (g === 0) {
      if (list.includes(0)) on.add(0);
      if (cur.char) { const hair = list.filter((x) => x > 0); if (hair.length) on.add(hair.includes(1) ? 1 : hair[0]); }
      else list.forEach((x) => on.add(x));
    } else {
      if (cur.char && g === 17) continue; // 17xx = death knight eye glow
      // 3202 = face (3201 = hidden under helmets); 702 = ears (701 = no ears)
      const d = (cur.char && g === 32 && list.includes(3202)) ? 3202 : (cur.char && g === 7 && list.includes(702)) ? 702 : list.find((x) => x % 100 === 1); // 3202 = face (3201 = hidden under helmets)
      if (d !== undefined) on.add(d);
      else if (!cur.char) on.add(list[0]);
    }
  }
  return { ids, on };
}

// --- body texture compositing (character skin + face + underwear + gear)
const LAYOUT = {
  2: { w: 2048, sec: { 0: [0, 0, 512, 256], 1: [0, 256, 512, 256], 2: [0, 512, 512, 128], 3: [512, 0, 512, 256], 4: [512, 256, 512, 128], 5: [512, 384, 512, 256], 6: [512, 640, 512, 256], 7: [512, 896, 512, 128], 9: [1024, 0, 1024, 1024], 10: [1024, 0, 1024, 1024] } },
  1: { w: 1024, sec: { 0: [0, 0, 512, 256], 1: [0, 256, 512, 256], 2: [0, 512, 512, 128], 3: [512, 0, 512, 256], 4: [512, 256, 512, 128], 5: [512, 384, 512, 256], 6: [512, 640, 512, 256], 7: [512, 896, 512, 128], 9: [0, 640, 512, 128], 10: [0, 768, 512, 256] } },
};
const SECTION_DIRS = { armuppertexture: 0, armlowertexture: 1, handtexture: 2, torsouppertexture: 3, torsolowertexture: 4, leguppertexture: 5, leglowertexture: 6, foottexture: 7 };
const SECTION_NAMES = ["Upper arm", "Lower arm", "Hand", "Upper torso", "Lower torso", "Upper leg", "Lower leg", "Foot"];
function imgToCanvas(img) {
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  c.getContext("2d").putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  return c;
}
async function composeBody(mode) {
  const ch = cur.char, dir = dirname(cur.modelLC), sfx = ch.hd ? "_hd" : "";
  const race = basename(dir.replace(/\/(male|female)$/, "")), sex = ch.sex;
  const pre = `${dir}/${race}${sex}`;
  const skinLC = `${pre}skin00_${cur.slots.skin}${sfx}.blp`;
  const base = await imgLC(skinLC, mode);
  const c = document.createElement("canvas"); c.width = base.width; c.height = base.height;
  const g = c.getContext("2d");
  g.drawImage(imgToCanvas(base), 0, 0);
  const lay = base.width === base.height * 2 ? LAYOUT[2] : LAYOUT[1];
  const sc = c.width / lay.w;
  const draw = async (lc, sec, srcMode = mode) => {
    try {
      const im = await imgLC(lc, srcMode);
      const [x, y, w, h] = lay.sec[sec];
      g.drawImage(imgToCanvas(im), x * sc, y * sc, w * sc, h * sc);
    } catch {}
  };
  if (cur.slots.face) { await draw(`${pre}facelower${cur.slots.face}_${cur.slots.skin}${sfx}.blp`, 9); await draw(`${pre}faceupper${cur.slots.face}_${cur.slots.skin}${sfx}.blp`, 10); }
  if (cur.slots.underwear) { await draw(`${pre}nakedpelvisskin00_${cur.slots.skin}${sfx}.blp`, 5); await draw(`${pre}nakedtorsoskin00_${cur.slots.skin}${sfx}.blp`, 3); }
  const order = [5, 6, 7, 3, 4, 0, 1, 2]; // legs, feet, chest, arms, hands
  for (const sec of order) for (const o of cur.overlays.filter((x) => x.section === sec)) {
    const m = texMode(mode) === "game" ? "game" : o.src ? o.src : texMode(mode);
    await draw(o.lc, sec, m);
  }
  return canvasTexture(c);
}

// --- render both sides
let refreshSeq = 0;
async function loadSide(mode, side = 0) {
  const m2b = await readLC(cur.modelLC, mode);
  const model = parseM2(m2b);
  let skinB;
  try { skinB = model.skinFids[0] ? await readFid(model.skinFids[0], mode) : await readLC(cur.modelLC.replace(/\.m2$/, "00.skin"), mode); }
  catch { skinB = await readLC(cur.modelLC.replace(/\.m2$/, "00.skin"), mode); }
  // hair replacements show on the left view, on whichever body it shows (your build, a mod, or the game)
  if (side === 0 && Object.keys(hairCfg(cur.modelLC)).length) {
    try { const r = await mixedFor(cur.modelLC, m2b, skinB, modelMode(mode)); cur.hairNotes = r.notes; cur.hairErr = null; return { model: parseM2(r.m2), skin: parseSkin(r.skin), mixed: true }; }
    catch (e) { cur.hairErr = e.message; cur.hairNotes = null; }
  } else if (side === 0) { cur.hairErr = null; cur.hairNotes = null; }
  return { model, skin: parseSkin(skinB) };
}
// --- hair mixer: profile.hair[modelLc] = { styleId: { src: sourceKey | "@game", fit } }
const hairCfg = (lc) => (S.profile.hair && S.profile.hair[lc]) || {};
const srcMode = (key) => (key === "@game" ? "game" : S.sources.find((s) => s.key.toLowerCase() === key.toLowerCase()));
async function readSkin0(lc, m2b, mode) {
  const m = parseM2(m2b);
  try { if (m.skinFids[0]) return await readFid(m.skinFids[0], mode); } catch {}
  return readLC(lc.replace(/\.m2$/, "00.skin"), mode);
}
async function bonesFor(m2b, mode) {
  const s = skeletonOf(m2b);
  if (s.bones) return s.bones;
  let fid = s.skelFid, guard = 0;
  while (fid && guard++ < 4) { const k = skelBones(await readFid(fid, mode)); if (k.bones) return k.bones; fid = k.parentFid; }
  return null;
}
const donorCache = new Map();
function donorData(lc, key) {
  const k = key + "|" + lc;
  if (!donorCache.has(k)) {
    const p = (async () => {
      const mode = srcMode(key); if (!mode) throw new Error("that mod folder is gone");
      const m2 = await readLC(lc, mode), skin = await readSkin0(lc, m2, mode);
      return { m2, skin, bones: await bonesFor(m2, mode), ids: hairIdsOf(skin) };
    })();
    donorCache.set(k, p); p.catch(() => donorCache.delete(k));
    if (donorCache.size > 4) donorCache.delete(donorCache.keys().next().value);
  }
  return donorCache.get(k);
}
let mixCache = null;
function mixedFor(lc, m2b, skinB, mode = "build") {
  const cfg = hairCfg(lc);
  const sig = lc + "|" + JSON.stringify(cfg) + "|" + m2b.length + "|" + skinB.length + "|" + (sourceFor(lc, mode)?.key || "game");
  if (mixCache && mixCache.sig === sig) return mixCache.p;
  const p = (async () => {
    const donors = [];
    const own = sourceFor(lc, mode)?.key || "@game";
    for (const [id, c] of Object.entries(cfg)) {
      if (c.src.toLowerCase() === own.toLowerCase() && (c.from == null || +c.from === +id)) continue; // same hairstyle from the same model: nothing to do
      const d = await donorData(lc, c.src); donors.push({ id: +id, from: c.from != null ? +c.from : +id, m2: d.m2, skin: d.skin, bones: d.bones, fit: c.fit !== false });
    }
    if (!donors.length) return { m2: m2b, skin: skinB, notes: ["no hairstyle differs from this body's own"] };
    return mixHair({ m2: m2b, skin: skinB, bones: await bonesFor(m2b, mode) }, donors);
  })();
  mixCache = { sig, p }; p.catch(() => { if (mixCache && mixCache.sig === sig) mixCache = null; });
  return p;
}
async function setHair(id, key, fit, from) {
  const all = S.profile.hair, c = (all[cur.modelLC] ||= {});
  if (!key) delete c[id]; else c[id] = { src: key, from: from ?? c[id]?.from ?? id, fit: fit ?? c[id]?.fit ?? true };
  if (!Object.keys(c).length) delete all[cur.modelLC];
  for (const x of cur.geo.ids) if (x > 0 && x < 100) cur.geo.on.delete(x);
  cur.geo.on.add(id);
  await saveProfile(); refresh();
}
function hairPanel(P) {
  const lc = cur.modelLC, ids = cur.geo.ids.filter(isHairId);
  if (!lc || !ids.length) return;
  const body = sourceFor(lc, "build"), cfg = hairCfg(lc);
  const donors = S.sources.filter((s) => s.files.has(lc));
  const shown = ids.find((x) => cur.geo.on.has(x)) ?? ids[0];
  const names = cur.cm ? CHR.hairNames(cur.cm) : new Map();
  const label = (id) => names.has(id) ? "Style " + names.get(id) : "Part " + id;
  // one row per hairstyle slot of your body: [mod] [which of its hairstyles]
  const row = (id) => {
    const c = cfg[id];
    const modSel = el("select", { style: "flex:1;min-width:0" });
    modSel.append(el("option", { value: "" }, "Keep as is"));
    modSel.append(el("option", { value: "@game", selected: c?.src === "@game" }, "Original game"));
    for (const d of donors) modSel.append(el("option", { value: d.key, title: d.name, selected: c?.src === d.key }, d.name.split(/[\\›]/).map((x) => x.trim()).slice(-2).join(" › ") + (d === body ? " (your body)" : d.enabled ? "" : " (off)")));
    const styleSel = el("select", { style: "width:150px", disabled: !c });
    const fillStyles = async (key, keep) => {
      styleSel.innerHTML = "";
      if (!key) { styleSel.append(el("option", { value: "" }, "-")); styleSel.disabled = true; return; }
      styleSel.append(el("option", { value: "" }, "reading..."));
      let have; try { have = [...(await donorData(lc, key)).ids].sort((a, b) => a - b); } catch { have = []; }
      styleSel.innerHTML = "";
      if (!have.length) { styleSel.append(el("option", { value: "" }, "(no hairstyles)")); styleSel.disabled = true; return; }
      for (const h of have) styleSel.append(el("option", { value: h, selected: h === keep }, label(h)));
      if (!have.includes(keep)) styleSel.value = String(have.includes(id) ? id : have[0]);
      styleSel.disabled = false;
      return +styleSel.value;
    };
    modSel.onchange = async () => {
      const key = modSel.value;
      if (!key) return setHair(id, null);
      const from = await fillStyles(key, c?.from ?? id);
      if (from) setHair(id, key, undefined, from);
    };
    styleSel.onchange = () => setHair(id, modSel.value, undefined, +styleSel.value);
    if (c) fillStyles(c.src, c.from ?? id); else fillStyles("", 0);
    return el("div", { style: "margin-top:6px;padding:4px 6px;border-radius:6px;" + (id === shown ? "background:rgba(255,255,255,.06)" : "") },
      el("div", { class: "note", style: "cursor:pointer", title: "Click to show this hairstyle on the left", onclick: () => { for (const x of ids) cur.geo.on.delete(x); cur.geo.on.add(id); refresh(); } },
        (id === shown ? "▶ " : "") + label(id) + (id === shown ? " (shown)" : "") + (c ? " · replaced" : "")),
      el("div", { class: "row" }, modSel, styleSel),
      c ? el("label", { title: "Moves the hair so the other model's head bone sits on your body's head bone. Turn off if the hair floats." },
        el("input", { type: "checkbox", checked: c.fit !== false, onchange: (ev) => setHair(id, c.src, ev.target.checked, c.from) }), "Fit to head") : null);
  };
  const n = Object.keys(cfg).length;
  P.append(el("h3", {}, `Hairstyles${n ? ` (${n} replaced)` : ""}`), el("div", { class: "note" },
    `Replace the hairstyle your character has selected (pick it with the Hair Style option above) with a hairstyle from any mod or the original game. ` +
    `"Keep as is" leaves it alone. Shown on the left view; the right view never changes. Build puts it in game.`));
  if (n) P.append(el("button", { onclick: async () => { if (!confirm("Set every hairstyle back to \"Keep as is\"?")) return; delete S.profile.hair[lc]; mixCache = null; await saveProfile(); refresh(); } }, "Keep all as is"));
  if (cur.hairErr) P.append(el("div", { class: "note", style: "color:#f88" }, "Could not mix: " + cur.hairErr));
  else if (cur.hairNotes) P.append(el("div", { class: "note" }, cur.hairNotes.join(" · ")));
  P.append(row(shown));
  // other hairstyles that are replaced: listed by name, click to switch to one
  const others = Object.keys(cfg).map(Number).filter((id) => id !== shown && ids.includes(id));
  if (others.length) P.append(el("div", { class: "note", style: "margin-top:4px" }, "Also replaced: ",
    ...others.map((id, k) => el("span", { style: "cursor:pointer;text-decoration:underline", title: "Show this hairstyle", onclick: () => { for (const x of ids) cur.geo.on.delete(x); cur.geo.on.add(id); refresh(); } }, label(id) + (k < others.length - 1 ? ", " : "")))));
}
async function sideTextures(model, mode) {
  const texs = [];
  for (let t = 0; t < model.textures.length; t++) {
    const tx = model.textures[t];
    try {
      if (tx.type === 0) {
        if (!tx.fid) { texs.push(null); (texs.errors ||= []).push(`texture ${t}: no file ID in the model`); continue; }
        const s = sourceFor(lcForFid(tx.fid) || "", mode);
        const img = await loadImg((s ? s.key : "game") + "|fid" + tx.fid, () => readFid(tx.fid, mode));
        texs.push(dataTexture(img, !!(tx.flags & 1), !!(tx.flags & 2)));
      } else if (cur.cm) {
        const key = tx.type;
        const ct = await composeChr(key, mode) || (cur.slots[key] ? dataTexture(await imgLC(cur.slots[key], mode), !!(tx.flags & 1), !!(tx.flags & 2)) : null);
        texs.push(ct); if (!ct) (texs.errors ||= []).push(`texture ${t} (type ${key}): no customization texture for it`);
      } else if (tx.type === 1 && cur.char) texs.push(await composeBody(mode));
      else if (cur.slots[tx.type]) texs.push(dataTexture(await imgLC(cur.slots[tx.type], mode), !!(tx.flags & 1), !!(tx.flags & 2)));
      else { texs.push(null); (texs.errors ||= []).push(`texture ${t} (type ${tx.type}): no skin chosen for it`); }
    } catch (e) { texs.push(null); (texs.errors ||= []).push(`texture ${t}${model.textures[t].fid ? " (ID " + model.textures[t].fid + ")" : " (type " + model.textures[t].type + ")"}: ${e?.message || e}`); }
  }
  return texs;
}
async function refresh(first = false) {
  if (!cur.entry) return;
  const seq = ++refreshSeq;
  const sides = [modeFromSelect($("#srcA")), modeFromSelect($("#srcB"))];
  if (!cur.modelLC) { // textures only
    renderProps(null, null);
    for (let i = 0; i < 2; i++) show2D(i, null, sides[i]);
    return;
  }
  const msgs = [$("#msgA"), $("#msgB")];
  msgs.forEach((m) => (m.textContent = "Loading..."));
  const loaded = await Promise.all(sides.map((m, i) => loadSide(m, i).catch((e) => ({ error: e }))));
  if (seq !== refreshSeq) return;
  const ok = loaded.filter((x) => !x.error);
  if (!cur.inited && ok.length) {
    cur.slots = defaultSlots(ok[0].model, dirname(cur.modelLC));
    const ids = new Set(); for (const x of ok) for (const sm of x.skin.submeshes) ids.add(sm.id);
    cur.geo = defaultGeo({ submeshes: [...ids].map((id) => ({ id })) });
    cur.hairBase = [...cur.geo.on].find(isHairId) ?? null;
    if (cur.char && CHR) { cur.cm = CHR.modelFor(S.idByPath.get(cur.modelLC)) || null; if (cur.cm) { cur.custom = CHR.defaults(cur.cm); applyCustomGeo(); } }
    cur.inited = true;
    const ap = (S.profile.lastPreset || {})[cur.modelLC];
    if (ap && presetsFor()[ap]) applyPreset(presetsFor()[ap]);
  }
  for (let i = 0; i < 2; i++) {
    const x = loaded[i];
    if (x.error) { V.clear(i); hide2D(i); msgs[i].textContent = "Not available here: " + x.error.message; continue; }
    const texs = await sideTextures(x.model, sides[i]);
    if (seq !== refreshSeq) return;
    hide2D(i);
    const box = V.setModel(i, x.model, x.skin, (ti) => texs[ti] || null, (id) => geoOn(i, id));
    if (!cur.framed) { V.frame(box); cur.framed = true; }
    const src = sourceFor(cur.modelLC, sides[i]);
    msgs[i].textContent = `${basename(cur.modelLC)} · ${src ? "from " + src.name : "game file"}${x.mixed ? " + mixed hair" : ""} · ${x.model.pos.length / 3} vertices`;
    const used = new Set(x.skin.batches.filter((b) => { const sm = x.skin.submeshes[b.submesh]; return sm && geoOn(i, sm.id); }).map((b) => x.model.textureLookup[b.textureCombo]));
    texs.errors = (texs.errors || []).filter((e) => used.has(+/^texture (\d+)/.exec(e)[1]));
    if (texs.errors.length) { msgs[i].textContent += ` · ${texs.errors.length} texture(s) missing: ` + texs.errors.join("; "); console.warn("textures", texs.errors); }
  }
  const first0 = ok[0];
  cur.modelA = loaded[0].error ? first0?.model : loaded[0].model;
  cur.skinA = loaded[0].error ? first0?.skin : loaded[0].skin;
  renderProps(cur.modelA, cur.skinA);
}
function hide2D(i) { $(i ? "#tB" : "#tA").style.display = "none"; }
async function show2D(i, lc, mode) {
  const box = $(i ? "#tB" : "#tA"), msg = $(i ? "#msgB" : "#msgA");
  V.clear(i);
  box.style.display = "flex";
  const cv = box.querySelector("canvas");
  lc ||= cur.texLC;
  if (!lc) { cv.width = cv.height = 1; msg.textContent = "This folder has textures only; pick one on the right."; return; }
  try {
    const img = await imgLC(lc, mode);
    cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
    const s = sourceFor(lc, mode);
    msg.textContent = `${basename(lc)} · ${img.fullWidth}×${img.fullHeight} · ${s ? "from " + s.name : "game file"}`;
  } catch (e) { cv.width = cv.height = 1; msg.textContent = "Not available here: " + e.message; }
}

// --- properties panel
// --- character design presets: profile.presets[modelLc][name] = { custom, slots, geo, overlays }
// The design stays while the model / skin dropdowns change, so the same look can be compared across mods.
const presetsFor = () => (S.profile.presets[cur.modelLC] ||= {});
function presetOf() {
  return {
    custom: { ...(cur.custom || {}) },
    slots: { ...cur.slots },
    geo: cur.geo ? [...cur.geo.on] : [],
    overlays: cur.overlays.map((o) => ({ section: o.section, lc: o.lc, src: o.src ? o.src.key : null, setKey: o.setKey, label: o.label })),
  };
}
function applyPreset(p) {
  if (p.custom && cur.cm) { cur.custom = { ...cur.custom }; for (const [k, v] of Object.entries(p.custom)) cur.custom[k] = v; applyCustomGeo(); }
  if (p.slots) Object.assign(cur.slots, p.slots);
  if (p.geo && cur.geo) cur.geo.on = new Set(p.geo.filter((id) => cur.geo.ids.includes(id)));
  if (p.overlays) cur.overlays = p.overlays.map((o) => ({ ...o, src: o.src ? S.sources.find((x) => x.key.toLowerCase() === o.src.toLowerCase()) || null : null }));
}
function presetPanel(P) {
  const all = presetsFor(), names = Object.keys(all).sort((a, b) => a.localeCompare(b));
  const last = S.profile.lastPreset[cur.modelLC] || "";
  const sel = el("select", { style: "flex:1", onchange: async () => {
    const n = sel.value;
    if (n) { applyPreset(all[n]); S.profile.lastPreset[cur.modelLC] = n; } else delete S.profile.lastPreset[cur.modelLC];
    await saveProfile(); refresh();
  } });
  sel.append(el("option", { value: "" }, names.length ? "(no preset)" : "(no presets yet)"));
  for (const n of names) sel.append(el("option", { value: n, selected: n === last }, n));
  const save = el("button", { onclick: async () => {
    const n = (prompt("Name for this character design (same name = overwrite):", last || "My character") || "").trim();
    if (!n) return;
    all[n] = presetOf(); S.profile.lastPreset[cur.modelLC] = n;
    await saveProfile(); renderProps(cur.modelA, cur.skinA); status(`Saved preset "${n}"`);
  } }, "Save as...");
  const del = el("button", { disabled: !last, onclick: async () => {
    if (!last || !confirm(`Delete preset "${last}"?`)) return;
    delete all[last]; delete S.profile.lastPreset[cur.modelLC];
    await saveProfile(); renderProps(cur.modelA, cur.skinA);
  } }, "Delete");
  P.append(el("h3", {}, "My character presets"),
    el("div", { class: "note" }, "Saves the look (customization, hair, parts, gear you're trying on). The chosen preset loads every time you open this model."),
    el("div", { class: "row" }, sel, save, del));
}
function renderProps(model, skin) {
  const P = $("#mProps"); P.innerHTML = "";
  gearItemPanel(P);
  const e = cur.entry; if (!e) return;
  P.append(el("div", { style: "font-weight:600;font-size:14px" }, e.label), el("div", { class: "note" }, entryDirs(e).join(" + ")));
  if (e.models.size > 1) {
    const sel = el("select", { onchange: () => {
      cur.modelLC = sel.value; cur.framed = false; cur.geo = null; cur.inited = false; cur.cm = null;
      const d = dirname(cur.modelLC); if (/^character\//.test(d)) cur.char = parseCharDir(d, cur.modelLC) || cur.char;
      refresh(true);
    } });
    for (const m of [...e.models].sort()) sel.append(el("option", { value: m, selected: m === cur.modelLC }, basename(m)));
    P.append(el("h3", {}, "Model"), sel);
  }
  if (model) {
    if (cur.char) presetPanel(P);
    P.append(el("h3", {}, "Textures"));
    if (cur.cm) {
      for (const o of CHR.options(cur.cm)) {
        const s = el("select", { onchange: () => { cur.custom[o.id] = +s.value; applyCustomGeo(); refresh(); } });
        for (const c of o.choices) s.append(el("option", { value: c.id, selected: cur.custom[o.id] === c.id }, `${c.n}${c.name ? " · " + c.name : ""}${c.ok ? "" : " (locked)"}`));
        P.append(el("label", {}, el("span", { style: "width:110px" }, o.name), s));
      }
      if (cur.geo) hairPanel(P);
      P.append(el("label", {}, el("input", { type: "checkbox", checked: cur.slots.underwear !== false, onchange: (ev) => { cur.slots.underwear = ev.target.checked; refresh(); } }), "Underwear"));
    }
    if (cur.char) {
      const o = charOptions(dirname(cur.modelLC), cur.char.hd);
      const mk = (label, key, opts, fmt = (x) => x) => {
        const s = el("select", { onchange: () => { cur.slots[key] = s.value || null; refresh(); } });
        if (key !== "skin") s.append(el("option", { value: "" }, "(none)"));
        for (const x of opts) s.append(el("option", { value: x, selected: cur.slots[key] === x }, fmt(x)));
        return el("label", {}, el("span", { style: "width:90px" }, label), s);
      };
      if (!cur.cm) P.append(mk("Skin colour", "skin", o.skins, (x) => "Colour " + (+x + 1)), mk("Face", "face", o.faces, (x) => "Face " + (+x + 1)), mk("Hair texture", "6", o.hair, basename));
      if (!cur.cm) P.append(el("label", {}, el("input", { type: "checkbox", checked: !!cur.slots.underwear, onchange: (ev) => { cur.slots.underwear = ev.target.checked; refresh(); } }), "Underwear layer"));
      if (cur.overlays.length) {
        P.append(el("h3", {}, "Trying on"));
        const groups = new Map(); for (const o of cur.overlays) { const k = o.setKey || o.lc; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
        for (const [k, os] of groups) {
          const label = os[0].label || basename(os[0].lc).replace(/_(au|al|ha|tu|tl|lu|ll|fo)(_[fmu])?\.blp$/, "");
          const parts = [...new Set(os.map((o) => pieceOf(o)))].map(pieceLabel).join(", ");
          P.append(el("div", { class: "row", title: os.map((o) => basename(o.lc)).join("\n") }, el("span", { class: "pill" }, parts), el("span", { style: "flex:1;overflow:hidden;text-overflow:ellipsis" }, label), el("button", { onclick: () => { cur.overlays = cur.overlays.filter((o) => !os.includes(o)); refresh(); renderGearList(); } }, "×")));
        }
        P.append(el("button", { onclick: () => { cur.overlays = []; refresh(); } }, "Take everything off"));
      }
    }
    if (cur.variations && cur.variations.length) {
      const vs = el("select", { onchange: () => { const v = cur.variations.find((x) => x.key === vs.value); cur.variation = v.key; [11, 12, 13].forEach((t, k) => (cur.slots[t] = v.paths[k])); refresh(); } });
      for (const v of cur.variations) vs.append(el("option", { value: v.key, selected: cur.variation === v.key }, v.paths.filter(Boolean).map(basename).join(" + ") + `  (${v.displays.length} NPC look${v.displays.length > 1 ? "s" : ""})`));
      P.append(el("label", {}, el("span", { style: "width:90px" }, "Variation"), vs));
    }
    const files = texCandidates(dirname(cur.modelLC));
    const types = [...new Set(model.textures.map((t) => t.type))].filter((t) => t !== 0 && !(cur.char && (t === 1 || t === 6 || (t >= 15 && t <= 18))));
    for (const t of types) {
      const s = el("select", { onchange: () => { cur.slots[t] = s.value || null; refresh(); } });
      s.append(el("option", { value: "" }, "(none)"));
      const opts = files.includes(cur.slots[t]) || !cur.slots[t] ? files : [cur.slots[t], ...files];
      for (const f of opts) s.append(el("option", { value: f, selected: cur.slots[t] === f }, basename(f)));
      P.append(el("label", {}, el("span", { style: "width:90px" }, TEX_TYPES[t] || "Type " + t), s));
    }
  }
  if (skin && cur.geo) {
    P.append(el("h3", {}, "Parts (geosets)"), el("div", { class: "note" }, "0 = body, 1-99 = hair styles, 401 gloves, 501 boots, 1301 legs/robe, 1501+ capes ..."));
    const box = el("div", { class: "geos" });
    for (const id of cur.geo.ids) box.append(el("label", {}, el("input", { type: "checkbox", checked: cur.geo.on.has(id), onchange: (ev) => { ev.target.checked ? cur.geo.on.add(id) : cur.geo.on.delete(id); refresh(); } }), String(id)));
    P.append(box);
  }
  // files in this folder and who provides them
  const all = [...entryFiles(e)].filter((lc) => sourcesTouching([lc]).length);
  if (all.length) {
    P.append(el("h3", {}, `Modded files here (${all.length})`));
    const touching = sourcesTouching(all);
    const useBtns = el("div", { class: "row" });
    for (const s of touching) useBtns.append(el("button", { onclick: () => useVersion(s, all) }, "Use " + s.name.split("\\").pop() + " for all"));
    useBtns.append(el("button", { onclick: () => useVersion("@game", all) }, "Use original for all"), el("button", { onclick: () => useVersion(null, all) }, "Clear picks"));
    P.append(el("div", { class: "note" }, "Picks decide which version goes into your build, whatever the load order says."), useBtns);
    const list = el("details", { style: "margin-top:6px" }, el("summary", {}, "Choose a version per file"));
    for (const lc of all.sort()) list.append(fileRow(lc, () => renderProps(cur.modelA, cur.skinA)));
    P.append(list);
  }
}
function fileRow(lc, after) {
  const provs = sourcesTouching([lc]);
  const pick = S.profile.picks[lc];
  const sel = el("select", { onchange: async () => { setPick(lc, sel.value === "" ? null : sel.value); await saveProfile(); refresh(); after && after(); } });
  sel.append(el("option", { value: "" }, "Load order: " + (sourceFor(lc, "build")?.name || "game")));
  if (S.idByPath.has(lc)) sel.append(el("option", { value: "@game", selected: pick === "@game" }, "Original game"));
  for (const s of provs) sel.append(el("option", { value: s.key, selected: pick && pick.toLowerCase() === s.key.toLowerCase() }, s.name + (s.enabled ? "" : " (off)")));
  const name = el("div", { class: "note", style: "cursor:pointer", title: lc, onclick: () => { cur.texLC = lc; if (lc.endsWith(".blp")) { show2D(0, lc, modeFromSelect($("#srcA"))); show2D(1, lc, modeFromSelect($("#srcB"))); } } }, basename(lc) + (S.idByPath.has(lc) ? "" : S.customPaths.has(lc) ? " (custom ID)" : " (unknown to game)"));
  return el("div", { style: "margin:4px 0" }, name, sel);
}
function setPick(lc, v) { S.gearCache = null; if (v) S.profile.picks[lc] = v; else delete S.profile.picks[lc]; }
async function useVersion(s, lcs) {
  for (const lc of lcs) {
    if (s === null) setPick(lc, null);
    else if (s === "@game") { if (S.idByPath.has(lc)) setPick(lc, "@game"); }
    else if (s.files.has(lc)) setPick(lc, s.key);
  }
  await saveProfile();
  status("Picks saved. Press Build on the Load order tab to apply them.");
  refresh();
}

// ---------------------------------------------------------------- gear try-on
// Gear sets: one entry per look (e.g. Cloth_A_01 Black), merged across all mod folders.
// Each set has pieces (chest, pants, boots ...) that can be worn on their own, so a top from one set and a bottom from another works.
const ARMOR = [["cloth", "Cloth"], ["leather", "Leather"], ["mail", "Mail"], ["plate", "Plate"], ["robe", "Robes"]];
const PIECE_NORM = { sleeves: "sleeve", gloves: "glove", hands: "glove", hand: "glove", pants: "pant", legs: "pant", leg: "pant", boots: "boot", foot: "boot", bracers: "bracer", cuff: "bracer", cuffs: "bracer", arm: "sleeve", arms: "sleeve" };
const PIECE_LABEL = { chest: "Chest", shirt: "Shirt", robe: "Robe", tabard: "Tabard", sleeve: "Sleeves", glove: "Gloves", bracer: "Bracers", belt: "Belt", pant: "Pants", boot: "Boots" };
const PIECE_ORDER = ["chest", "shirt", "robe", "tabard", "sleeve", "bracer", "glove", "belt", "pant", "boot"];
const SECTION_PIECE = { 0: "sleeve", 1: "sleeve", 2: "glove", 3: "chest", 4: "chest", 5: "pant", 6: "pant", 7: "boot" };
function gearSets() {
  if (S.gearCache) return S.gearCache;
  const sets = new Map();
  for (const s of S.sources) for (const [lc] of s.files) {
    const m = /^item\/texturecomponents\/([a-z]+)\/(.+)\.blp$/.exec(lc);
    if (!m || SECTION_DIRS[m[1]] === undefined) continue;
    const section = SECTION_DIRS[m[1]];
    const name = m[2];
    const g = (/_([fmu])$/.exec(name) || [])[1] || "u";
    const noSec = name.replace(/_[fmu]$/, "").replace(/_(au|al|ha|tu|tl|lu|ll|fo)$/, "");
    const pm = /_(chest|sleeve|sleeves|glove|gloves|belt|pant|pants|boot|boots|robe|bracer|bracers|shirt|tabard|leg|legs|foot|hand|hands|arm|arms|cuff|cuffs)$/.exec(noSec);
    const base = pm ? noSec.slice(0, pm.index) : noSec;
    const piece = pm ? (PIECE_NORM[pm[1]] || pm[1]) : SECTION_PIECE[section];
    let st = sets.get(base);
    if (!st) {
      const fm = /^(.*?_\d+)_?([a-z][a-z0-9_]*)?$/.exec(base);
      const at = ARMOR.find(([k]) => base.startsWith(k));
      sets.set(base, (st = { key: base, base, family: fm ? fm[1] : base, colour: fm && fm[2] ? fm[2] : "", armor: at ? at[1] : "Other", files: new Map(), srcs: new Set() }));
    }
    st.srcs.add(s);
    if (!st.files.has(lc)) st.files.set(lc, { lc, section, gender: g, piece });
  }
  for (const st of sets.values()) {
    st.files = [...st.files.values()];
    for (const f of st.files) f.src = sourceFor(f.lc, "build") || S.sources.find((x) => x.files.has(f.lc));
    const pieces = new Map();
    for (const f of st.files) { let pc = pieces.get(f.piece); if (!pc) pieces.set(f.piece, (pc = { key: st.key + "|" + f.piece, piece: f.piece, set: st, files: [] })); pc.files.push(f); }
    st.pieces = [...pieces.values()].sort((a, b) => PIECE_ORDER.indexOf(a.piece) - PIECE_ORDER.indexOf(b.piece));
  }
  S.gearCache = [...sets.values()];
  return S.gearCache;
}
const pretty = (s) => s.replace(/_/g, " ").replace(/\b([a-z])/g, (x) => x.toUpperCase());
function pieceOf(f) {
  const name = basename(f.lc).replace(/\.blp$/, "").replace(/_[fmu]$/, "").replace(/_(au|al|ha|tu|tl|lu|ll|fo)$/, "");
  const m = /_(chest|sleeve|sleeves|glove|gloves|belt|pant|pants|boot|boots|robe|bracer|bracers|shirt|tabard|leg|legs|foot|hand|hands|arm|arms|cuff|cuffs)$/.exec(name);
  return m ? (PIECE_NORM[m[1]] || m[1]) : SECTION_PIECE[f.section];
}
const pieceLabel = (p) => PIECE_LABEL[p] || pretty(p);
function gearItemNames() {
  if (!IT.loaded || IT.byTex) return;
  IT.byTex = new Map();
  for (const { id, name } of IT.list) {
    const f = itemFiles(id);
    for (const t of f.textures) if (t.lc.startsWith("item/texturecomponents/")) { let a = IT.byTex.get(t.lc); if (!a) IT.byTex.set(t.lc, (a = [])); if (!a.includes(name)) a.push(name); }
  }
}
function namesOf(files) { const n = new Set(); for (const f of files) for (const x of (IT.byTex && IT.byTex.get(f.lc)) || []) n.add(x); return [...n].sort((a, b) => a.localeCompare(b)); }
const wearing = (files) => files.length > 0 && [...new Set(files.map((f) => f.section))].every((sec) => cur.overlays.some((o) => o.section === sec && files.some((f) => f.lc === o.lc)));
const gearCollapsed = new Set();
// build state of some gear files: "all" | "some" | "none"
function buildState(files) { const n = files.filter((f) => sourceFor(f.lc, "build") || (S.profile.remap && S.profile.remap[f.lc])).length; return n === 0 ? "none" : n === files.length ? "all" : "some"; }
function buildPill(files) {
  const st = buildState(files);
  const label = st === "all" ? "✓ In build" : st === "some" ? "◐ Partly" : "＋ Add to build";
  const from = [...new Set(files.map((f) => sourceFor(f.lc, "build")?.name).filter(Boolean))];
  return el("span", { class: "pill" + (st === "all" ? " on" : st === "some" ? " warn" : ""), style: "cursor:pointer;white-space:nowrap", title: (st === "none" ? "Not in your build: the game shows its normal texture. Click to add it." : "Goes into your build from: " + from.join("; ") + ". Click to remove it from the build.") + "\nPress Build on the Load order tab to apply.",
    onclick: async (ev) => { ev.stopPropagation(); await setGearInBuild(files, st === "none"); } }, label);
}
async function setGearInBuild(files, on) {
  for (const f of files) {
    if (on) { const s = f.src || S.sources.find((x) => x.files.has(f.lc)); const def = S.sources.find((x) => x.enabled && x.files.has(f.lc)); setPick(f.lc, def && def === s ? null : s.key); }
    else setPick(f.lc, isGamePath(f.lc) ? "@game" : null);
  }
  await saveProfile(); S.gearCache = null;
  status("Build changed · press Build on the Load order tab to apply");
  renderGearList();
}
// Gear tab: game items whose body textures a mod replaces. Pick an item, try it on, choose the version you like for each of its textures.
const ARMOR_SUB = { 1: "Cloth", 2: "Leather", 3: "Mail", 4: "Plate" };
const INV = { 4: "Shirt", 5: "Chest", 6: "Waist", 7: "Legs", 8: "Feet", 9: "Wrists", 10: "Hands", 19: "Tabard", 20: "Robe", 1: "Head", 3: "Shoulder", 16: "Back" };
function gearItems() {
  if (S.gearItems) return S.gearItems;
  const items = [], used = new Set();
  for (const { id, name } of IT.list) {
    const files = itemFiles(id).textures.filter((t) => t.section >= 0 && t.lc.startsWith("item/texturecomponents/"));
    if (!files.length) continue;
    files.forEach((f) => used.add(f.lc));
    const modded = files.filter((f) => sourcesTouching([f.lc]).length);
    const r = IT.item.get(id);
    const armor = r && r.v[0] === 4 && ARMOR_SUB[r.v[1]] ? ARMOR_SUB[r.v[1]] : "Other (shirts, tabards ...)";
    const slot = (r && INV[r.v[3]]) || "Other";
    items.push({ id, name, armor, slot, files, modded, tex: (modded.length ? modded : files).map((f) => basename(f.lc)).sort()[0] });
  }
  // modded body textures no game item uses
  const orphans = gearSets().map((st) => ({ st, files: st.files.filter((f) => !used.has(f.lc)) })).filter((x) => x.files.length);
  S.gearItems = { items, orphans };
  return S.gearItems;
}
async function renderGearList() {
  const selSrc = $("#gSource");
  if (!selSrc.options.length) {
    selSrc.append(el("option", { value: "" }, "All mod folders"), el("option", { value: "@in" }, "Only what is in my build"), el("option", { value: "@out" }, "Only what is not in my build"));
    for (const s of S.sources) if ([...s.files.keys()].some((k) => k.startsWith("item/texturecomponents/"))) selSrc.append(el("option", { value: s.key }, s.name + (s.enabled ? "" : " (off)")));
    selSrc.onchange = renderGearList;
    $("#gSearch").oninput = renderGearList;
    $("#gSearch").placeholder = "Search items or texture names";
    const only = el("label", { class: "note" }, el("input", { type: "checkbox", id: "gOnlyModded", checked: true, onchange: renderGearList }), " Show only items that have mods");
    const sort = el("select", { id: "gSort", onchange: renderGearList });
    for (const [v, t] of [["set", "Group by item set"], ["slot", "Group by part (chest, legs ...)"], ["item", "Sort by item name"], ["texture", "Sort by texture name"]]) sort.append(el("option", { value: v }, t));
    const mat = el("select", { id: "gMat", onchange: renderGearList });
    for (const t of ["All materials", "Cloth", "Leather", "Mail", "Plate", "Other (shirts, tabards ...)"]) mat.append(el("option", { value: t === "All materials" ? "" : t }, t));
    const orph = el("label", { class: "note" }, el("input", { type: "checkbox", id: "gOrphans", onchange: renderGearList }), " Show textures no game item uses");
    selSrc.after(mat, sort, only, orph);
  }
  if (!IT.loaded) { try { await loadItems(); } catch (e) { console.warn(e); busy(null); } }
  gearItemNames();
  if (!IT.setOf) { IT.setOf = new Map(); try { const d = new DB2(await S.casc.readFid(1343609)); for (const r of d.rows) { const n = d.str(r, 0); for (const iid of r.v[4] || []) if (iid && !IT.setOf.has(iid)) IT.setOf.set(iid, n); } } catch (e) { console.warn("item sets", e); } }
  const { items, orphans } = gearItems();
  const mode = $("#gSort").value;
  const q = $("#gSearch").value.trim().toLowerCase();
  const box = $("#gList"); box.innerHTML = "";
  box.append(el("div", { class: "note", style: "padding:6px 10px" }, "Click an item to try it on and choose its version on the right. ✓ In build = a mod version goes into your game when you press Build; Original = the game's own look."));
  const srcOk = (files) => selSrc.value === "@in" ? buildState(files) !== "none" : selSrc.value === "@out" ? buildState(files) !== "all" : (!selSrc.value || files.some((f) => sourcesTouching([f.lc]).some((x) => x.key === selSrc.value)));
  const onlyModded = $("#gOnlyModded").checked;
  const matSel = $("#gMat").value;
  const list = items.filter((it) => (!matSel || it.armor === matSel) && (it.modded.length || it.files.some((f) => S.profile.remap[f.lc]) ? srcOk(it.modded) : !onlyModded && !selSrc.value) && (!q || it.name.toLowerCase().includes(q) || it.modded.some((f) => f.lc.includes(q))));
  const header = (label, n) => {
    const closed = gearCollapsed.has(mode + label) && !q;
    box.append(el("div", { class: "grp", onclick: () => { gearCollapsed.has(mode + label) ? gearCollapsed.delete(mode + label) : gearCollapsed.add(mode + label); renderGearList(); } }, `${closed ? "▸" : "▾"} ${label} (${n})`));
    return closed;
  };
  const row = (it, sub) => {
    const swapped = it.files.filter((f) => S.profile.remap[f.lc]);
    const st = buildState(it.modded.length ? [...new Set([...it.modded, ...swapped])] : swapped.length ? swapped : []);
    return el("div", { class: "it" + (cur.gearItem === it.id ? " on" : ""), title: it.modded.map((f) => basename(f.lc)).join("\n"), onclick: () => selectGearItem(it, mode === "set" && !!setNameOf(it)) },
      el("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, it.name, el("span", { class: "note" }, " · " + sub)),
      el("span", { class: "pill" + (st === "all" ? " on" : st === "some" ? " warn" : ""), style: "margin-left:auto;white-space:nowrap" }, st === "none" && !it.modded.length ? "No mods" : st === "all" ? "✓ In build" : st === "some" ? "◐ Partly" : "Original"));
  };
  const byName = (a, b) => a.name.localeCompare(b.name) || a.id - b.id;
  if (mode === "item" || mode === "texture") {
    const l = [...list].sort(mode === "item" ? byName : (a, b) => a.tex.localeCompare(b.tex) || byName(a, b));
    for (const it of l) box.append(row(it, mode === "texture" ? it.tex.replace(/\.blp$/, "") : it.armor.split(" ")[0] + " " + it.slot.toLowerCase()));
  } else if (mode === "set") {
    const NO = "Not part of a set";
    const sets = new Map();
    for (const it of list) { const n = setNameOf(it) || NO; if (!sets.has(n)) sets.set(n, []); sets.get(n).push(it); }
    for (const n of [...sets.keys()].filter((x) => x !== NO).sort((a, b) => a.localeCompare(b)).concat(sets.has(NO) ? [NO] : [])) {
      const l = sets.get(n).sort(byName);
      if (header(n, l.length)) continue;
      for (const it of l) box.append(row(it, it.armor.split(" ")[0] + " " + it.slot.toLowerCase()));
    }
  } else {
    const key = mode === "slot" ? "slot" : "armor";
    const order = mode === "slot" ? [...new Set(["Chest", "Robe", "Shirt", "Tabard", "Wrists", "Hands", "Waist", "Legs", "Feet", ...list.map((x) => x.slot)])] : ["Cloth", "Leather", "Mail", "Plate", "Other (shirts, tabards ...)"];
    for (const g of order) {
      const l = list.filter((x) => x[key] === g).sort(byName);
      if (!l.length || header(g, l.length)) continue;
      for (const it of l) box.append(row(it, mode === "slot" ? it.armor.split(" ")[0] : it.slot.toLowerCase()));
    }
  }
  const orph = !$("#gOrphans").checked ? [] : orphans.filter((o) => srcOk(o.files) && (!q || o.st.base.includes(q)));
  if (orph.length && !header("Textures no game item uses", orph.length)) {
    for (const o of orph) box.append(el("div", { class: "it" + (wearing(o.files) ? " on" : ""), title: o.files.map((f) => basename(f.lc)).join("\n"), onclick: () => toggleGear(o.files) },
      el("span", {}, pretty(o.st.base)), el("span", { style: "margin-left:auto" }, buildPill(o.files))));
  }
  if (box.children.length < 2) box.append(el("div", { class: "note", style: "padding:10px" }, "No modded gear found."));
}
// Set of an item: the game's own item set, or else a "look-alike" set of items with matching names
// (Tuxedo Jacket + Tuxedo Pants + White Tuxedo Shirt). Look-alike sets need 2+ items covering 2+ body parts.
const COLOURS = new Set("white black blue red green yellow purple brown dark light grey gray gold golden silver pink orange crimson azure violet teal".split(" "));
function nameStem(name) {
  const w = name.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/['’]s\b/g, "").split(/\s+/).filter(Boolean);
  const strip = (a) => { let k = 0; while (k < a.length && COLOURS.has(a[k].toLowerCase())) k++; return a.slice(k); };
  let st = strip(w.slice(0, -1));
  if (!st.length) st = strip(w);
  return st.join(" ");
}
// texture family of a body texture file: cloth_b_08black_pant_lu_u.blp -> cloth_b_08black
function texBase(lc) {
  const n = basename(lc).replace(/\.blp$/, "").replace(/_[fmu]$/, "").replace(/_(au|al|ha|tu|tl|lu|ll|fo)$/, "");
  return n.replace(/_(chest|sleeve|sleeves|glove|gloves|belt|pant|pants|boot|boots|robe|bracer|bracers|shirt|tabard|leg|legs|foot|hand|hands|arm|arms|cuff|cuffs)$/, "");
}
// Items not in an official set are tied together when their names match (Tuxedo Jacket + Tuxedo Pants)
// or when they use the same texture family (made to fit together). Very common families (shared by many items) are not used as links.
function setNameOf(it) {
  const official = IT.setOf && IT.setOf.get(it.id);
  if (official) return official;
  if (!IT.looks) {
    IT.looks = new Map();
    const items = gearItems().items.filter((x) => !(IT.setOf && IT.setOf.get(x.id)));
    const parent = new Map(items.map((x) => [x.id, x.id]));
    const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(a, b); };
    const link = (groups, max) => { for (const xs of groups.values()) if (xs.length >= 2 && xs.length <= max && new Set(xs.map((x) => x.slot)).size >= 2) for (const x of xs) join(xs[0].id, x.id); };
    const byName = new Map(), byTex = new Map();
    for (const x of items) {
      const k = nameStem(x.name).toLowerCase(); if (k) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(x); }
      for (const b of new Set(x.files.map((f) => texBase(f.lc)))) { if (!byTex.has(b)) byTex.set(b, []); byTex.get(b).push(x); }
    }
    link(byName, 12);
    link(byTex, 6);
    const comps = new Map();
    for (const x of items) { const r = find(x.id); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(x); }
    for (const xs of comps.values()) {
      if (xs.length < 2 || xs.length > 16 || new Set(xs.map((x) => x.slot)).size < 2) continue; // huge chains are not real sets
      const cnt = new Map(); for (const x of xs) { const k = nameStem(x.name); if (k) cnt.set(k, (cnt.get(k) || 0) + 1); }
      const best = [...cnt.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
      const label = (best && best[1] >= 2 ? best[0] : xs.map((x) => x.name).sort()[0]) + " (look-alike set)";
      for (const x of xs) IT.looks.set(x.id, label);
    }
  }
  return IT.looks.get(it.id) || null;
}
function selectGearItem(it, wholeSet = false) {
  if (!cur.char) { status("Pick a playable character on the Models tab first."); switchTab("models"); return; }
  cur.gearItem = it.id; cur.gearItemObj = it; cur.swapping = null; cur.swapPreview = null;
  const want = cur.char.sex === "female" ? "f" : "m";
  const g = (lc) => (/_([fmu])\.blp$/.exec(lc) || [])[1] || "u";
  cur.overlays = []; // preview only the clicked item (or its whole set)
  const setName = wholeSet ? setNameOf(it) : null;
  // pieces are layered like in game (pants under boots and belt, chest under belt ...), so a belt no longer wipes the pants
  const LAYER = ["Shirt", "Legs", "Chest", "Feet", "Wrists", "Hands", "Waist", "Robe", "Tabard"];
  const rank = (x) => { const k = LAYER.indexOf(x.slot); return k < 0 ? 99 : k; };
  const pieces = (setName ? gearItems().items.filter((x) => setNameOf(x) === setName) : [it]).sort((a, b) => rank(a) - rank(b));
  for (const p of pieces) {
    const bySec = new Map();
    for (const f of p.files) { const old = bySec.get(f.section); if (!old || g(f.lc) === want || (g(old.lc) !== want && g(f.lc) === "u")) bySec.set(f.section, f); }
    for (const [sec, f] of bySec) cur.overlays.push({ section: sec, lc: f.lc, src: null, setKey: "item:" + p.id, label: p.name });
  }
  renderGearList();
  refresh();
}
// right-hand panel on the Gear tab: versions of each texture of the selected item
function gearItemPanel(P) {
  const it = cur.gearItemObj;
  if (!it || !$("#tab-gear").classList.contains("on")) return;
  if (cur.swapping && cur.swapping.it === it) { P.append(cur.swapping.el); return; }
  const card = el("div", { class: "card", style: "padding:8px 10px" });
  card.append(el("div", { style: "font-weight:600;font-size:14px" }, it.name), el("div", { class: "note" }, `${it.armor.split(" ")[0]} · ${it.slot} · left view = your build, right view = what you pick in its menu. ✓ = in your build`));
  // one choice per piece of clothing (upper+lower torso = chest, upper+lower leg = pants ...), so parts can be mixed
  const groups = new Map();
  if (!it.modded.length) card.append(el("div", { class: "note", style: "margin-top:6px" }, "None of your mod folders change this item. It is shown with the game's own textures."));
  for (const f of it.files) { const pc = pieceOf(f); if (!groups.has(pc)) groups.set(pc, []); groups.get(pc).push(f); }
  for (const pc of PIECE_ORDER.filter((p) => groups.has(p)).concat([...groups.keys()].filter((p) => !PIECE_ORDER.includes(p)))) {
    const files = groups.get(pc);
    const lcs = files.map((f) => f.lc);
    const provs = sourcesTouching(lcs);
    const sharers = new Set(); for (const lc of lcs) for (const n of IT.byTex.get(lc) || []) if (n !== it.name) sharers.add(n);
    card.append(el("h3", {}, pieceLabel(pc)), el("div", { class: "note", title: lcs.join("\n") }, `${files.length} texture file${files.length > 1 ? "s" : ""}` + (sharers.size ? ` · shared with ${sharers.size} other item${sharers.size > 1 ? "s" : ""}` : "")));
    // what the build uses now: one source for all files, or "@game"
    const rms = lcs.filter((lc) => S.profile.remap[lc]);
    const effs = rms.length ? ["@remap"] : [...new Set(lcs.map((lc) => sourceFor(lc, "build")?.key || "@game"))];
    if (rms.length) {
      const r = S.profile.remap[rms[0]];
      const from = r.src === "@game" ? "game" : (S.sources.find((x) => x.key.toLowerCase() === r.src.toLowerCase())?.name.split("\\").pop() || r.src);
      card.append(el("div", { class: "row", style: "margin:4px 0" }, el("span", { class: "pill on" }, "✓ Swapped"), el("span", { class: "note", style: "flex:1", title: rms.map((lc) => S.profile.remap[lc].lc).join("\n") }, `using ${texBase(r.lc)} (${from})`),
        el("button", { onclick: async () => { for (const lc of lcs) delete S.profile.remap[lc]; await saveProfile(); S.gearItems = null; renderGearList(); refresh(); } }, "Undo")));
    }
    const options = [{ key: "@game", label: "Original game", mode: "game" }, ...provs.map((s) => ({ key: s.key, label: s.name.split("\\").pop() + (s.enabled ? "" : " (off)"), mode: s }))];
    const grid = el("div", { style: "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px" });
    for (const o of options) {
      const mine = o.mode && o.mode.files ? lcs.filter((lc) => o.mode.files.has(lc)) : lcs;
      const on = effs.length === 1 && effs[0].toLowerCase() === o.key.toLowerCase();
      const t = el("div", { class: "thumb" + (on ? " on" : ""), style: "width:auto", title: o.label + (on ? " (in your build)" : "") + (mine.length < lcs.length ? `\n(has ${mine.length} of the ${lcs.length} files; the rest stay original)` : ""),
        onclick: async () => { for (const lc of lcs) { delete S.profile.remap[lc]; setPick(lc, mine.includes(lc) ? o.key : (isGamePath(lc) ? "@game" : null)); } await saveProfile(); S.gearItems = null; status("Build changed · press Build on the Load order tab to apply"); renderGearList(); refresh(); } },
        el("canvas", { width: 160, height: 120, style: "width:100%;height:auto" }), el("div", {}, (on ? "✓ " : "") + o.label));
      grid.append(t);
      itemThumb(files.filter((f) => mine.includes(f.lc)), o.mode).then((c) => { c.style.width = "100%"; c.style.height = "auto"; t.replaceChild(c, t.firstChild); });
    }
    card.append(grid, el("button", { style: "margin-top:6px;width:100%", onclick: () => openSwapPicker(it, pc, files) }, `Use another texture for the ${pieceLabel(pc).toLowerCase()}…`));
  }
  if (others(it)) card.append(el("div", { class: "note", style: "margin-top:6px" }, "A choice applies to the texture file, so every item that uses it changes too."));
  P.append(card);
  function others(x) { return x.files.some((f) => (IT.byTex.get(f.lc) || []).length > 1); }
}

// ---- texture swap picker: any body texture (from mods or the game, used or unused) can be put under an item's file names
function texIndex() {
  if (S.texIndex) return S.texIndex;
  const idx = new Map();
  const add = (lc) => {
    const m = /^item\/texturecomponents\/([a-z]+)\/(.+)\.blp$/.exec(lc);
    if (!m || SECTION_DIRS[m[1]] === undefined) return;
    const f = { lc, section: SECTION_DIRS[m[1]], g: (/_([fmu])$/.exec(m[2]) || [])[1] || "u" };
    const piece = pieceOf(f), base = texBase(lc), key = base + "|" + piece;
    let c = idx.get(key); if (!c) idx.set(key, (c = { key, base, piece, files: [], seen: new Set() }));
    if (!c.seen.has(lc)) { c.seen.add(lc); c.files.push(f); }
  };
  // game textures: only ones actually stored in this install (the listfile also names files from other game versions)
  for (const [lc, fid] of S.idByPath) if (lc.startsWith("item/texturecomponents/") && S.casc.has(fid)) add(lc);
  for (const s of S.sources) for (const lc of s.files.keys()) if (lc.startsWith("item/texturecomponents/")) add(lc);
  for (const c of idx.values()) { c.mods = sourcesTouching(c.files.map((f) => f.lc)); c.used = c.files.some((f) => IT.byTex && IT.byTex.has(f.lc)); }
  S.texIndex = [...idx.values()].sort((a, b) => a.base.localeCompare(b.base));
  return S.texIndex;
}
// The picker lives in the right panel; clicking a texture previews it on the character (left view), "Use this" keeps it.
function openSwapPicker(it, pc, targets) {
  cur.swapping = { it, pc, targets, sel: null, shown: 0 };
  cur.swapPreview = null;
  const secs = new Set(targets.map((f) => f.section));
  const wrap = el("div", { class: "card", style: "padding:8px 10px" });
  const q = el("input", { placeholder: "Search texture or item names (tuxedo, raidrogue, robe ...)", style: "width:100%" });
  const which = el("select", { style: "width:100%" }, el("option", { value: "all" }, "All textures"), el("option", { value: "unused" }, "Only textures no game item uses"), el("option", { value: "used" }, "Only textures game items use"));
  const onlyMods = el("input", { type: "checkbox" }), modVer = el("input", { type: "checkbox", checked: true }), same = el("input", { type: "checkbox", checked: true });
  const list = el("div", { class: "list", style: "max-height:55vh;overflow:auto;margin-top:6px;border:1px solid var(--line);border-radius:6px;flex:none" });
  const useBtn = el("button", { class: "primary", disabled: true, onclick: () => applySwap() }, "Use this");
  const more = el("button", { style: "width:100%;margin-top:4px" }, "Show more");
  wrap.append(
    el("div", { style: "font-weight:600" }, `${it.name}: other texture for the ${pieceLabel(pc).toLowerCase()}`),
    el("div", { class: "note" }, "Click a texture to see it on the character (left view). Body parts are matched (upper torso → upper torso ...); parts it doesn't have stay as they are."),
    el("div", { class: "row", style: "margin:6px 0" }, useBtn, el("button", { onclick: () => closeSwap() }, "Cancel")),
    q, which,
    el("label", { class: "note" }, onlyMods, " only textures that have mods"),
    el("label", { class: "note" }, modVer, " show mod versions (off = the game's own look)"),
    el("label", { class: "note" }, same, ` only ${pieceLabel(pc).toLowerCase()} textures`),
    list, more);
  let cands = [];
  const run = () => {
    const t = q.value.trim().toLowerCase(), w = which.value;
    cands = texIndex().filter((c) => c.files.some((f) => secs.has(f.section)) && (!same.checked || c.piece === pc) && (!onlyMods.checked || c.mods.length) &&
      (w === "all" || (w === "unused" ? !c.used : c.used)) && (!t || c.base.includes(t) || (c.names ||= namesOf(c.files).join("|").toLowerCase()).includes(t)));
    const rank = (c) => (c.mods.length ? 0 : 4) + (c.used ? 0 : 2) + (/^\d/.test(c.base) ? 1 : 0);
    cands.sort((a, b) => rank(a) - rank(b) || a.base.localeCompare(b.base));
    list.innerHTML = ""; cur.swapping.shown = 0; page();
  };
  const page = () => {
    const st = cur.swapping;
    for (const c of cands.slice(st.shown, st.shown + 40)) {
      const src = modVer.checked && c.mods.length ? (c.files.map((f) => sourceFor(f.lc, "build")).find(Boolean) || c.mods[0]) : null;
      const nm = namesOf(c.files);
      const row = el("div", { class: "it", style: "display:flex;gap:8px;align-items:center;padding:4px 6px;cursor:pointer", title: c.files.map((f) => f.lc).join("\n") + (nm.length ? "\nUsed by: " + nm.join(", ") : "") },
        el("canvas", { width: 80, height: 60, style: "width:80px;height:60px;flex:none" }),
        el("div", { style: "min-width:0" }, el("div", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, nm[0] || pretty(c.base)),
          el("div", { class: "note", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, (nm[0] ? pretty(c.base) + " · " : "") + (src ? src.name.split("\\").pop() : c.used ? "game" : "game · no item uses it") + (c.mods.length && !src ? " · has mods" : ""))));
      row.onclick = () => { for (const x of list.children) x.classList.remove("on"); row.classList.add("on"); previewSwap(c, src); useBtn.disabled = false; };
      list.append(row);
      itemThumb(c.files.filter((f) => secs.has(f.section)), src || "game").then((cv) => { cv.style.cssText = "width:80px;height:60px;flex:none"; row.replaceChild(cv, row.firstChild); });
    }
    st.shown += 40; more.style.display = st.shown < cands.length ? "" : "none";
    if (!cands.length) list.append(el("div", { class: "note", style: "padding:8px" }, "Nothing found."));
  };
  more.onclick = page; q.oninput = run; which.onchange = run; onlyMods.onchange = run; modVer.onchange = run; same.onchange = run;
  cur.swapping.el = wrap; cur.swapping.list = list;
  run();
  renderProps(cur.modelA, cur.skinA);
  q.focus();
}
function swapMapFor(targets, c, src) {
  const want = cur.char && cur.char.sex === "male" ? "m" : "f";
  const map = {};
  for (const t of targets) {
    const cands = c.files.filter((f) => f.section === t.section);
    if (!cands.length) continue;
    const tg = (/_([fmu])\.blp$/.exec(t.lc) || [])[1] || "u";
    const pick = cands.find((f) => f.g === tg) || cands.find((f) => f.g === "u") || cands.find((f) => f.g === want) || cands[0];
    const s = src && src.files.has(pick.lc) ? src : null;
    map[t.lc] = { lc: pick.lc, src: s ? s.key : "@game" };
  }
  return map;
}
function previewSwap(c, src) {
  cur.swapping.sel = { c, src };
  cur.swapPreview = swapMapFor(cur.swapping.targets, c, src);
  const sc = $("#mProps").scrollTop, ls = cur.swapping.list.scrollTop;
  refresh().then(() => { $("#mProps").scrollTop = sc; if (cur.swapping) cur.swapping.list.scrollTop = ls; });
}
async function applySwap() {
  const st = cur.swapping; if (!st || !st.sel) return;
  for (const t of st.targets) delete S.profile.remap[t.lc];
  Object.assign(S.profile.remap, swapMapFor(st.targets, st.sel.c, st.sel.src));
  await saveProfile(); S.gearItems = null;
  status("Texture swapped · press Build on the Load order tab to apply");
  closeSwap(); renderGearList();
}
function closeSwap() { cur.swapping = null; cur.swapPreview = null; refresh(); }

// put files on (replacing whatever is on the same body sections), or take them off if already worn
function toggleGear(files) {
  if (!cur.char) { status("Pick a playable character on the Models tab first."); switchTab("models"); return; }
  if (wearing(files)) cur.overlays = cur.overlays.filter((o) => !files.some((f) => f.lc === o.lc));
  else {
    const want = cur.char.sex === "female" ? "f" : "m";
    const bySec = new Map();
    for (const f of files) { const old = bySec.get(f.section); if (!old || (f.gender === want) || (old.gender !== want && f.gender === "u")) bySec.set(f.section, f); }
    for (const [sec, f] of bySec) {
      cur.overlays = cur.overlays.filter((o) => o.section !== sec);
      cur.overlays.push({ section: sec, lc: f.lc, src: f.src, setKey: f.lc });
    }
  }
  renderGearList();
  refresh();
}

// ---------------------------------------------------------------- items
const IT = { loaded: false }; window.IT = IT;
async function loadItems() {
  if (IT.loaded) return;
  busy("Reading the game's item tables...");
  const L = async (fid) => new DB2(await S.casc.readFid(fid));
  const [item, sparse, ima, ia, idi, mr, tfd, mfd, cmfd, ctfd] = await Promise.all([841626, 1572924, 982457, 982462, 1266429, 1280614, 982459, 1337833, 1349053, 1278239].map(L));
  IT.item = item; IT.idi = idi; IT.ia = ia; IT.cmfd = cmfd; IT.ctfd = ctfd;
  IT.names = new Map();
  for (const r of sparse.rows) { const raw = r.raw; let a = 0; for (let k = 0; k < 4; k++) { while (raw[a]) a++; a++; } let e = a; while (raw[e]) e++; IT.names.set(r.id, new TextDecoder().decode(raw.subarray(a, e))); }
  IT.ima = new Map(); for (const r of ima.rows) { const iid = r.v[1]; if (!IT.ima.has(iid)) IT.ima.set(iid, r.v[3]); }
  IT.mat = new Map(); for (const r of mr.rows) { if (!IT.mat.has(r.rel)) IT.mat.set(r.rel, []); IT.mat.get(r.rel).push(r.v); }
  IT.tex = new Map(); for (const r of tfd.rows) { const m = r.v[2]; if (!IT.tex.has(m)) IT.tex.set(m, []); IT.tex.get(m).push(r.id); }
  IT.mod = new Map(); for (const r of mfd.rows) { const m = r.v[4]; if (!IT.mod.has(m)) IT.mod.set(m, []); IT.mod.get(m).push(r.v[1]); }
  IT.list = [...IT.names.entries()].filter(([id, n]) => n).map(([id, name]) => ({ id, name }));
  IT.loaded = true;
  busy(null);
}
// body sections each kind of item actually paints in game (by InventoryType); the display data often lists filler textures for other sections
const SLOT_SECTIONS = { 4: [0, 1, 3, 4], 5: [0, 1, 3, 4, 5, 6], 20: [0, 1, 3, 4, 5, 6], 19: [3, 4], 6: [4, 5], 7: [5, 6], 8: [6, 7], 9: [1], 10: [1, 2] };
function itemFiles(id) {
  const out = { textures: [], models: [], display: null };
  const ir = IT.item.get(id), allowed = SLOT_SECTIONS[ir ? ir.v[3] : 0] || [];
  const appId = IT.ima.get(id); if (!appId) return out;
  const ap = IT.ia.get(appId); if (!ap) return out;
  const did = ap.v[1]; out.display = did;
  const d = IT.idi.get(did);
  for (const [sec, mat] of IT.mat.get(did) || []) if (allowed.includes(sec)) for (const fid of IT.tex.get(mat) || []) { const lc = S.pathById.get(fid); if (lc) out.textures.push({ section: sec, lc, fid }); }
  if (d) {
    d.v[10].forEach((res, k) => { if (!res) return; for (const fid of IT.mod.get(res) || []) { const lc = S.pathById.get(fid); if (lc) out.models.push({ lc, fid, slot: k, texRes: d.v[11][k] }); } });
    d.v[11].forEach((res) => { if (!res) return; for (const fid of IT.tex.get(res) || []) { const lc = S.pathById.get(fid); if (lc) out.textures.push({ section: -1, lc, fid }); } });
  }
  return out;
}
function itemIsModded(id) {
  const f = itemFiles(id);
  return [...f.textures, ...f.models].some((x) => sourcesTouching([x.lc]).length);
}
function renderItemList() {
  const q = $("#iSearch").value.trim().toLowerCase();
  const only = $("#iOnlyModded").checked;
  const box = $("#iList"); box.innerHTML = "";
  if (!q && !only) { box.append(el("div", { class: "note", style: "padding:10px" }, "Type part of an item name.")); return; }
  let n = 0;
  if (!IT.modded) { IT.modded = new Set(IT.list.filter((x) => itemIsModded(x.id)).map((x) => x.id)); }
  for (const it of IT.list) {
    if (q && !it.name.toLowerCase().includes(q)) continue;
    if (only && !IT.modded.has(it.id)) continue;
    if (++n > 400) { box.append(el("div", { class: "note", style: "padding:10px" }, "More results... type more of the name.")); break; }
    box.append(el("div", { class: "it" + (IT.cur === it.id ? " on" : ""), onclick: () => { IT.cur = it.id; renderItemList(); renderItemPage(it); } }, it.name, el("small", {}, "#" + it.id)));
  }
  if (!n) box.append(el("div", { class: "note", style: "padding:10px" }, "No items found."));
}
$("#iSearch").oninput = () => IT.loaded && renderItemList();
$("#iOnlyModded").onchange = () => IT.loaded && renderItemList();

// all body textures of an item drawn where they sit on the body texture (arms left, torso/legs right)
async function itemThumb(files, mode) {
  const c = el("canvas", { width: 160, height: 160 });
  const g = c.getContext("2d");
  const L = LAYOUT[1].sec, sc = 160 / 1024;
  const seen = new Set();
  const want = cur.char && cur.char.sex === "male" ? "_m.blp" : "_f.blp";
  files = [...files].sort((a, b) => b.lc.endsWith(want) - a.lc.endsWith(want));
  for (const f of files) {
    if (seen.has(f.section)) continue;
    try { const img = await imgLC(f.lc, mode); const [x, y, w, h] = L[f.section]; g.drawImage(imgToCanvas(img), x * sc, y * sc, w * sc, h * sc); seen.add(f.section); } catch {}
  }
  if (!seen.size) { g.fillStyle = "#888"; g.font = "12px sans-serif"; g.fillText("not available", 40, 84); return c; }
  // crop to the parts that were drawn
  let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0;
  for (const sec of seen) { const [x, y, w, h] = L[sec]; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); }
  const W = (x1 - x0) * sc, H = (y1 - y0) * sc, k = Math.min(160 / W, 120 / H);
  const out = el("canvas", { width: 160, height: 120 });
  out.getContext("2d").drawImage(c, x0 * sc, y0 * sc, W, H, (160 - W * k) / 2, (120 - H * k) / 2, W * k, H * k);
  return out;
}
async function thumb(lc, mode) {
  const c = el("canvas", { width: 160, height: 120 });
  try {
    const img = await imgLC(lc, mode);
    const g = c.getContext("2d"); const tmp = imgToCanvas(img);
    const s = Math.min(160 / img.width, 120 / img.height);
    g.drawImage(tmp, (160 - img.width * s) / 2, (120 - img.height * s) / 2, img.width * s, img.height * s);
  } catch { const g = c.getContext("2d"); g.fillStyle = "#888"; g.font = "12px sans-serif"; g.fillText(lc.endsWith(".m2") ? "3D model" : "not available", 40, 64); }
  return c;
}
async function renderItemPage(it) {
  const P = $("#iPage"); P.innerHTML = "";
  const f = itemFiles(it.id);
  P.append(el("h2", { style: "margin-top:0" }, it.name), el("div", { class: "note" }, `Item ${it.id} · display ${f.display ?? "none"}`));
  const all = [...f.textures, ...f.models];
  if (!all.length) { P.append(el("p", {}, "This item has no model or texture files listed in the game data.")); return; }
  const hasTex = f.textures.some((t) => t.section >= 0);
  if (hasTex) P.append(el("p", {}, el("button", { class: "primary", onclick: () => tryOnItem(f) }, "Try it on (Models tab)")));
  all.sort((a, b) => sourcesTouching([b.lc]).length - sourcesTouching([a.lc]).length);
  let plain = null;
  for (const x of all) {
    const provs = sourcesTouching([x.lc]);
    if (!provs.length) {
      if (!plain) { plain = el("details", { class: "card" }, el("summary", {}, "Files no mod replaces")); P.append(plain); }
      plain.append(el("div", { class: "note" }, x.lc));
      continue;
    }
    const card = el("div", { class: "card" });
    card.append(el("h2", {}, (x.section >= 0 ? SECTION_NAMES[x.section] + ": " : x.lc.endsWith(".m2") ? "Model: " : "Model texture: ") + basename(x.lc)), el("div", { class: "note" }, x.lc));
    if (x.lc.endsWith(".m2")) card.append(el("p", {}, el("button", { onclick: () => openModel(x.lc, f) }, "Preview this model in 3D")));
    const pick = S.profile.picks[x.lc];
    const effective = sourceFor(x.lc, "build");
    const options = [{ key: "", label: "Load order (" + (effective ? effective.name : "game") + ")", mode: "build" }, { key: "@game", label: "Original game", mode: "game" }, ...provs.map((s) => ({ key: s.key, label: s.name + (s.enabled ? "" : " (off)"), mode: s }))];
    const row = el("div", { class: "thumbs" });
    for (const o of options) {
      const on = (pick || "") .toLowerCase() === o.key.toLowerCase();
      const t = el("div", { class: "thumb" + (on ? " on" : ""), onclick: async () => { setPick(x.lc, o.key || null); await saveProfile(); renderItemPage(it); } }, el("canvas", { width: 160, height: 120 }), el("div", { title: o.label }, o.label));
      row.append(t);
      thumb(x.lc, o.mode).then((c) => t.replaceChild(c, t.firstChild));
    }
    card.append(row);
    if (!provs.length) card.append(el("div", { class: "note" }, "No mod replaces this file."));
    P.append(card);
  }
}
async function openModel(lc, f) {
  const texLC = f ? (f.textures.find((t) => t.section < 0) || {}).lc : null;
  const e = { key: "adhoc|" + lc, group: "Item models", dir: dirname(lc), label: basename(lc).replace(/\.m2$/, ""), models: new Set([lc]), modded: true };
  switchTab("models");
  cur.forcedSlots = texLC ? { 2: texLC } : null;
  await selectEntry(e);
}
function tryOnItem(f) {
  if (!cur.char) { status("Pick a playable character on the Models tab first."); switchTab("models"); return; }
  const want = cur.char.sex === "female" ? "_f.blp" : "_m.blp";
  const bySec = new Map();
  for (const t of f.textures) if (t.section >= 0 && t.section <= 7) { const old = bySec.get(t.section); if (!old || t.lc.endsWith(want) || (!old.lc.endsWith(want) && t.lc.endsWith("_u.blp"))) bySec.set(t.section, t); }
  for (const [sec, t] of bySec) { cur.overlays = cur.overlays.filter((o) => o.section !== sec); cur.overlays.push({ section: sec, lc: t.lc, src: null, setKey: "item" }); }
  switchTab("models"); refresh();
}

// ---------------------------------------------------------------- load order + build
function conflictsOf(s) {
  let shared = 0, wins = 0, loses = 0;
  for (const lc of s.files.keys()) {
    const others = S.sources.filter((o) => o !== s && o.enabled && o.files.has(lc));
    if (!others.length) continue;
    shared++;
    sourceFor(lc, "build") === s ? wins++ : loses++;
  }
  return { shared, wins, loses };
}
// ---------------------------------------------------------------- saved load orders (plans)
// profile.loadOrders[name] = { sources, picks, remap, hair, saved } — switch between plans without building or touching Arctium
function loadOrderSaves() {
  const all = (S.profile.loadOrders ||= {}), names = Object.keys(all).sort((a, b) => a.localeCompare(b));
  const sel = el("select", { style: "min-width:220px" });
  sel.append(el("option", { value: "" }, names.length ? "(choose a saved load order)" : "(none saved yet)"));
  for (const n of names) sel.append(el("option", { value: n, selected: n === S.profile.currentLoadOrder }, `${n}  ·  ${all[n].sources.filter((x) => x.enabled).length} on  ·  ${(all[n].saved || "").slice(0, 16).replace("T", " ")}`));
  const snap = () => {
    const P = S.profile, copy = (o) => JSON.parse(JSON.stringify(o || {}));
    return { sources: S.sources.map((x) => ({ path: x.key, enabled: x.enabled })), picks: copy(P.picks), remap: copy(P.remap), hair: copy(P.hair), view: copy(P.view), saved: new Date().toISOString() };
  };
  const save = el("button", { onclick: async () => {
    const n = (prompt("Name for this load order (same name = overwrite):", S.profile.currentLoadOrder || "Plan 1") || "").trim();
    if (!n) return;
    all[n] = snap(); S.profile.currentLoadOrder = n;
    await saveProfile(); renderOrderPage(); status(`Saved load order "${n}"`);
  } }, "Save current as...");
  const load = el("button", { onclick: async () => {
    const n = sel.value; if (!n) return;
    if (!confirm(`Switch to "${n}"? Your current order, on/off states, picks, swaps and hair choices are replaced (save them first if you want to keep them).`)) return;
    const L = JSON.parse(JSON.stringify(all[n]));
    Object.assign(S.profile, { sources: L.sources, picks: L.picks || {}, remap: L.remap || {}, hair: L.hair || {}, view: L.view || S.profile.view || {}, currentLoadOrder: n });
    busy("Loading " + n + "...");
    try { await scanSources(); await saveProfile(); await loadMappings(); } finally { busy(null); }
    S.gearCache = null; S.gearItems = null; mixCache = null;
    renderOrderPage(); renderModelList(); if (cur.entry) refresh();
    status(`Loaded "${n}" · ${S.sources.filter((x) => x.enabled).length} mod folders on · press Build to apply it`);
  } }, "Load");
  const del = el("button", { onclick: async () => {
    const n = sel.value; if (!n || !confirm(`Delete saved load order "${n}"?`)) return;
    delete all[n]; if (S.profile.currentLoadOrder === n) delete S.profile.currentLoadOrder;
    await saveProfile(); renderOrderPage();
  } }, "Delete");
  return el("div", { class: "card" }, el("h2", {}, "Saved load orders"),
    el("p", { class: "note" }, "Keep several plans and switch between them. A saved load order holds the order, which folders are on, per-file picks, texture swaps and hair choices. Nothing changes in the game until you press Build."),
    el("div", { class: "row" }, sel, load, save, del));
}
function renderOrderPage() {
  const P = $("#oPage"); P.innerHTML = "";
  const intro = el("div", { class: "card" }, el("h2", {}, "How this works"),
    el("p", {}, "Put your mod folders in order. ", el("b", {}, "Higher in the list wins"), " when two folders have the same file. Per-file picks (set in the Models and Items tabs) win over the order. Press ", el("b", {}, "Build"), " to write the result into one folder."),
    el("p", {}, "In the Arctium app, turn off your other mod folders and add just these two once:"),
    el("div", {}, "Mod folder: ", el("code", {}, S.info.outputDir)),
    el("div", {}, "File mapping: ", el("code", {}, winJoin(S.info.appDir, "LoadOrder-mappings.txt"))),
    el("p", { class: "note" }, "The build uses hard links where it can, so it takes no extra disk space and nothing in your mod folders is changed."));
  if (S.firstRun) intro.append(el("p", { class: "warn" }, "First run: the order and on/off states were copied from your current Arctium setup."));
  P.append(intro);

  const tbl = el("table");
  tbl.append(el("tr", {}, el("th", {}, "On"), el("th", {}, "#"), el("th", {}, "Mod folder"), el("th", {}, "Files"), el("th", {}, "Shared with other folders"), el("th", {}, "")));
  S.sources.forEach((s, i) => {
    const c = conflictsOf(s);
    const tr = el("tr", { class: (s.enabled ? "" : "off") + (S.orderSel === s ? " cur" : "") });
    tr.append(
      el("td", {}, el("input", { type: "checkbox", checked: s.enabled, onchange: async (ev) => { s.enabled = ev.target.checked; await afterOrderChange(); } })),
      el("td", {}, String(i + 1)),
      el("td", { style: "cursor:pointer", onclick: () => { S.orderSel = s; renderOrderPage(); } }, s.name, s.isNew ? el("span", { class: "pill warn", style: "margin-left:6px" }, "new") : null, s.missing ? el("span", { class: "pill", style: "margin-left:6px" }, "folder not found") : null),
      el("td", {}, String(s.files.size)),
      el("td", {}, s.enabled && c.shared ? `${c.shared} (wins ${c.wins}, loses ${c.loses})` : ""),
      el("td", { style: "white-space:nowrap" },
        el("button", { disabled: i === 0, onclick: () => move(i, -1) }, "▲"), " ",
        el("button", { disabled: i === S.sources.length - 1, onclick: () => move(i, +1) }, "▼"), " ",
        el("button", { onclick: () => move(i, -i) }, "Top")),
    );
    tbl.append(tr);
  });
  P.append(loadOrderSaves());
  P.append(el("div", { class: "card" }, el("h2", {}, "Load order"), tbl));
  if (S.orderSel) P.append(conflictCard(S.orderSel));

  const picks = Object.entries(S.profile.picks);
  const pc = el("div", { class: "card" }, el("h2", {}, `Per-file picks (${picks.length})`));
  if (!picks.length) pc.append(el("div", { class: "note" }, "None yet. Set them on the Models or Items tab."));
  else {
    const t = el("table");
    for (const [lc, v] of picks.sort()) t.append(el("tr", {}, el("td", {}, lc), el("td", {}, v === "@game" ? "Original game" : srcName(v)), el("td", {}, el("button", { onclick: async () => { setPick(lc, null); await saveProfile(); renderOrderPage(); } }, "Remove"))));
    pc.append(t, el("button", { onclick: async () => { S.profile.picks = {}; await saveProfile(); renderOrderPage(); } }, "Remove all picks"));
  }
  P.append(pc);

  const mc = el("div", { class: "card" }, el("h2", {}, "File mappings"),
    el("div", { class: "note" }, "Custom texture IDs (like Vell's) only work when a mapping line tells the game which file they are. These are collected from the .txt files inside your enabled mod folders and these mapping files:"));
  const ml = el("div");
  for (const p of S.profile.extraMappings) ml.append(el("div", { class: "row" }, el("code", {}, p), el("button", { onclick: async () => { S.profile.extraMappings = S.profile.extraMappings.filter((x) => x !== p); await saveProfile(); await loadMappings(); renderOrderPage(); } }, "Remove")));
  const inp = el("input", { placeholder: "Full path of another mapping .txt", style: "width:60%" });
  mc.append(ml, el("div", { class: "row", style: "margin-top:6px" }, inp, el("button", { onclick: async () => { if (inp.value.trim()) { S.profile.extraMappings.push(inp.value.trim()); await saveProfile(); await loadMappings(); renderOrderPage(); } } }, "Add")));
  mc.append(el("div", { class: "note", style: "margin-top:6px" }, `${S.customMap.size} custom IDs loaded. ${S.mappingConflicts.length} duplicate IDs pointing at different files (first one kept).`));
  P.append(mc);

  const bc = el("div", { class: "card" }, el("h2", {}, "Build"));
  const out = el("pre", { style: "display:none" });
  bc.append(el("div", { class: "row" }, el("button", { class: "primary", onclick: () => build(out) }, "Build my Arctium folder"), el("button", { onclick: () => checkMappings(out) }, "Only check mappings")), out);
  P.append(bc);
}
async function afterOrderChange() { S.gearCache = null; S.gearItems = null; await saveProfile(); await loadMappings(); renderOrderPage(); renderModelList(); status(`${S.sources.filter((s) => s.enabled).length} of ${S.sources.length} mod folders on · press Build to apply`); }
async function move(i, d) { const [s] = S.sources.splice(i, 1); S.sources.splice(i + d, 0, s); await afterOrderChange(); }
function conflictCard(s) {
  const card = el("div", { class: "card" }, el("h2", {}, "Files " + s.name + " shares with other folders"));
  const t = el("table");
  t.append(el("tr", {}, el("th", {}, "File"), el("th", {}, "Used in build"), el("th", {}, "Also in")));
  let n = 0;
  for (const lc of [...s.files.keys()].sort()) {
    const others = S.sources.filter((o) => o !== s && o.files.has(lc));
    if (!others.length) continue;
    if (++n > 500) break;
    const w = sourceFor(lc, "build");
    t.append(el("tr", {}, el("td", {}, lc), el("td", { class: w === s ? "ok" : "warn" }, w ? w.name : "game"), el("td", {}, others.map((o) => o.name + (o.enabled ? "" : " (off)")).join(", "))));
  }
  if (!n) card.append(el("div", { class: "note" }, "No overlaps."));
  else card.append(t);
  return card;
}

async function plan() {
  // lc -> source; files picked as "@game" are written from the game data
  const files = new Map();
  const unknown = [];
  for (const s of S.sources) if (s.enabled) for (const lc of s.files.keys()) {
    if (files.has(lc)) continue;
    const src = sourceFor(lc, "build");
    if (!src) { files.set(lc, null); continue; }
    if (!isGamePath(lc)) { if (!unknown.includes(lc)) unknown.push(lc); continue; }
    files.set(lc, src);
  }
  for (const [lc, v] of Object.entries(S.profile.picks)) {
    const src = sourceFor(lc, "build");
    if (v === "@game") files.set(lc, null); else if (src) files.set(lc, src);
  }
  const remaps = [];
  for (const [lc, r] of Object.entries(S.profile.remap || {})) { files.delete(lc); remaps.push([lc, r]); }
  return { files, unknown, remaps };
}
async function build(out) {
  out.style.display = "block"; out.textContent = "Working...";
  try {
    const { files, unknown, remaps } = await plan();
    const lines = [];
    let fromGame = 0, swapped = 0;
    for (const [lc, r] of remaps) {
      try {
        if (r.src === "@game") { const b = await S.casc.readFid(S.idByPath.get(r.lc)); await api("/api/write", { p: winJoin(S.info.outputDir, lc) }, { method: "POST", body: b }); lines.push(`K\t\t${lc}`); }
        else { const s = S.sources.find((x) => x.key.toLowerCase() === r.src.toLowerCase()); if (!s || !s.files.has(r.lc)) continue; lines.push(`L\t${winJoin(s.abs, s.files.get(r.lc).rel)}\t${lc}`); }
        swapped++;
      } catch (e) { console.warn("remap", lc, e); }
    }
    const hairNotes = [];
    for (const [lc, cfg] of Object.entries(S.profile.hair || {})) {
      if (!Object.keys(cfg).length) continue;
      try {
        const m2b = await readLC(lc, "build"), skinB = await readSkin0(lc, m2b, "build");
        const r = await mixedFor(lc, m2b, skinB);
        const m = parseM2(r.m2); parseSkin(r.skin); // must read back
        const skins = new Set(m.skinFids.map(lcForFid).filter(Boolean)); if (!skins.size) skins.add(lc.replace(/\.m2$/, "00.skin"));
        await api("/api/write", { p: winJoin(S.info.outputDir, lc) }, { method: "POST", body: r.m2 });
        files.delete(lc); lines.push(`K\t\t${lc}`);
        for (const sp of skins) { await api("/api/write", { p: winJoin(S.info.outputDir, sp) }, { method: "POST", body: r.skin }); files.delete(sp); lines.push(`K\t\t${sp}`); }
        hairNotes.push(`${lc}: ${r.notes.join("; ")} (model + ${skins.size} skin files)`);
      } catch (e) { hairNotes.push(`${lc}: hair mix FAILED, left as is: ${e.message}`); }
    }
    for (const [lc, src] of files) {
      if (src) { lines.push(`L\t${winJoin(src.abs, src.files.get(lc).rel)}\t${lc}`); continue; }
      // explicit "original game" pick: write the game file so it overrides any older copy
      if (S.profile.picks[lc] === "@game") {
        const b = await S.casc.readFid(S.idByPath.get(lc));
        await api("/api/write", { p: winJoin(S.info.outputDir, lc) }, { method: "POST", body: b });
        lines.push(`K\t\t${lc}`); fromGame++;
      }
    }
    const r = await (await api("/api/build", {}, { method: "POST", body: lines.join("\n") })).json();
    const rep = await checkMappings(null, files);
    out.textContent = `Build done: ${lines.length} files in ${S.info.outputDir}\n` +
      `  new hard links: ${r.linked}, copies: ${r.copied}, unchanged: ${r.unchanged}, removed: ${r.removed}, original game files written: ${fromGame}, swapped textures: ${swapped}\n` +
      (hairNotes.length ? `  mixed hair:\n    ${hairNotes.join("\n    ")}\n` : "") +
      (r.errors && r.errors.length ? `  errors:\n    ${[].concat(r.errors).join("\n    ")}\n` : "") +
      (unknown.length ? `  ${unknown.length} files skipped because the game doesn't know their path (no mapping), e.g. ${unknown.slice(0, 5).join(", ")}\n` : "") +
      "\n" + rep;
    status("Build finished. Start the game through Arctium to use it.");
  } catch (e) { out.textContent = "Build failed: " + e.message; }
}
async function checkMappings(out, files) {
  if (out) { out.style.display = "block"; out.textContent = "Checking models for missing textures..."; }
  files ||= (await plan()).files;
  const inBuild = (lc) => files.has(lc) ? !!files.get(lc) || S.profile.picks[lc] === "@game" : false;
  const lines = new Map(); // fid -> path for the combined mapping file
  const problems = [], fixes = [], unused = [];
  for (const [fid, m] of S.customMap) {
    if (inBuild(m.path) || S.idByPath.has(m.path)) lines.set(fid, m.path);
    else unused.push(`${fid} -> ${m.path}`);
  }
  // scan built models for texture IDs nobody knows
  const models = [...files.entries()].filter(([lc, s]) => lc.endsWith(".m2") && s);
  let n = 0;
  for (const [lc, src] of models) {
    if (out && ++n % 10 === 0) out.textContent = `Checking models... ${n}/${models.length}`;
    let txid = [];
    try {
      const abs = winJoin(src.abs, src.files.get(lc).rel);
      const head = await apiBytes("/api/read", { p: abs, o: 0, n: 8 });
      if (String.fromCharCode(...head.subarray(0, 4)) !== "MD21") continue;
      const sz = new DataView(head.buffer).getUint32(4, true);
      const total = src.files.get(lc).size;
      if (8 + sz >= total) continue;
      const tail = await apiBytes("/api/read", { p: abs, o: 8 + sz, n: total - 8 - sz });
      const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
      for (let p = 0; p + 8 <= tail.length;) {
        const id = String.fromCharCode(tail[p], tail[p + 1], tail[p + 2], tail[p + 3]); const size = dv.getUint32(p + 4, true);
        if (id === "TXID") for (let k = 0; k < size / 4; k++) txid.push(dv.getUint32(p + 8 + 4 * k, true));
        p += 8 + size;
      }
    } catch { continue; }
    for (const fid of txid) {
      if (!fid || S.casc.has(fid) || S.pathById.has(fid) || lines.has(fid)) continue;
      // unknown custom texture ID: try to guess from new textures in the same folder
      const dir = dirname(lc);
      const cands = [...files.keys()].filter((p) => dirname(p) === dir && p.endsWith(".blp") && !S.idByPath.has(p) && !S.customPaths.has(p));
      if (cands.length === 1) { fixes.push(`${fid};${cands[0]}`); lines.set(fid, cands[0]); problems.push(`${lc}: texture ID ${fid} had no mapping; guessed ${basename(cands[0])} (added)`); }
      else problems.push(`${lc}: texture ID ${fid} has no mapping -> will show bright green` + (cands.length ? ` (candidates: ${cands.map(basename).join(", ")})` : ""));
    }
  }
  if (fixes.length) {
    let old = ""; try { old = await apiText("/api/read", { p: winJoin(S.info.appDir, "extra-mappings.txt") }); } catch {}
    await api("/api/write", { p: winJoin(S.info.appDir, "extra-mappings.txt") }, { method: "POST", body: (old.trim() ? old.trim() + "\n" : "") + fixes.join("\n") + "\n" });
    await loadMappings();
  }
  const txt = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([f, p]) => `${f};${p}`).join("\n") + "\n";
  await api("/api/write", { p: winJoin(S.info.appDir, "LoadOrder-mappings.txt") }, { method: "POST", body: txt });
  const rep = `Mapping file written: ${lines.size} lines -> ${winJoin(S.info.appDir, "LoadOrder-mappings.txt")}\n` +
    (S.mappingConflicts.length ? `Duplicate IDs (first kept):\n  ${S.mappingConflicts.map((c) => `${c.fid}: kept ${c.kept.path} (${c.kept.origin}), dropped ${c.dropped.path} (${c.dropped.origin})`).join("\n  ")}\n` : "") +
    (problems.length ? `Problems:\n  ${problems.join("\n  ")}\n` : "No missing textures found in your build's models.\n") +
    (unused.length ? `${unused.length} mapping lines left out because their file isn't in your build (that mod is off): ${unused.slice(0, 4).join(", ")}${unused.length > 4 ? ", ..." : ""}\n` : "");
  if (out) out.textContent = rep;
  return rep;
}

// ---------------------------------------------------------------- tabs
function switchTab(name) {
  for (const b of $("#nav").children) b.classList.toggle("on", b.dataset.tab === name);
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t.id === "tab-" + name);
  if (name === "models" || name === "gear") {
    const tab = $("#tab-" + name);
    tab.append($(".center"), $("#mProps"));
    if (name === "gear") renderGearList();
    if (cur.entry) renderProps(cur.modelA, cur.skinA);
  }
  if (name === "items") loadItems().then(renderItemList).catch((e) => { busy(null); status("Item tables failed: " + e.message); });
  if (name === "order") renderOrderPage();
}
$("#nav").onclick = (e) => { if (e.target.dataset.tab) switchTab(e.target.dataset.tab); };
// ---------------------------------------------------------------- folder settings (WoW folder, mods folder, Arctium folder)
async function openFolders() {
  let info = S.info; try { info = await (await api("/api/info")).json(); } catch {}
  info ||= {};
  let dlg = $("#fdlg"); if (dlg) dlg.remove();
  const err = el("div", { class: "err" });
  const prod = el("select", {});
  const fillProducts = async (root, keep) => {
    let list = []; try { list = await (await api("/api/products", { p: root })).json(); } catch {}
    prod.innerHTML = "";
    for (const x of list) prod.append(el("option", { value: x, selected: x === keep }, x));
    if (!list.length) prod.append(el("option", { value: "" }, "(no game version found)"));
  };
  const row = (label, value, title, onpick) => {
    const inp = el("input", { type: "text", value: value || "" });
    const btn = el("button", { onclick: async () => {
      btn.disabled = true; err.textContent = "A folder window is open (it may be behind this window)...";
      try { const r = (await apiText("/api/pickfolder", { title, start: inp.value })).trim(); if (r) { inp.value = r; onpick && onpick(r); } } catch (e) { err.textContent = "Couldn't open the folder picker: " + e.message; }
      if (err.textContent.startsWith("A folder window")) err.textContent = "";
      btn.disabled = false;
    } }, "Browse...");
    return { inp, node: el("div", {}, el("div", { class: "note" }, label), el("div", { class: "row" }, inp, btn)) };
  };
  const w = row("World of Warcraft folder (the one that holds the Data folder)", info.wowRoot, "World of Warcraft folder", (r) => fillProducts(r, prod.value));
  const m = row("Mods folder (holds your Arctium mod folders, any depth)", info.modsRoot, "Mods folder");
  const a = row("Arctium app data folder (LocalState, holds a config folder)", (info.configFile || "").replace(/\\config\\[^\\]+$/i, ""), "Arctium app data folder");
  w.inp.onchange = () => fillProducts(w.inp.value, prod.value);
  await fillProducts(info.wowRoot || "", info.product);
  const save = el("button", { onclick: async () => {
    err.textContent = "Saving...";
    try {
      const r = await fetch("/api/settings", { method: "POST", body: JSON.stringify({ wowRoot: w.inp.value, modsRoot: m.inp.value, arctiumState: a.inp.value, product: prod.value }) });
      const t = await r.text();
      if (!r.ok) { err.textContent = t || "Couldn't save."; return; }
      err.textContent = "Saved. Reloading..."; setTimeout(() => location.reload(), 300);
    } catch (e) { err.textContent = "Couldn't save: " + e.message + " (an older version of the program may be running; restart it)"; }
  } }, "Save and reload");
  dlg = el("div", { id: "fdlg", class: "on", onclick: (ev) => { if (ev.target === dlg) dlg.remove(); } },
    el("div", { class: "box" },
      el("div", { style: "font-weight:600;font-size:15px" }, "Folders"),
      w.node, el("div", { class: "row" }, el("span", { class: "note" }, "Game version"), prod), m.node, a.node, err,
      el("div", { class: "row", style: "justify-content:flex-end" }, el("button", { onclick: () => dlg.remove() }, "Cancel"), save)));
  document.body.append(dlg);
}
$("#folders").onclick = () => openFolders();
$("#quit").onclick = async () => { try { await fetch("/api/quit"); } catch {} document.body.innerHTML = "<p style='padding:20px'>Arctium Mod Manager stopped. You can close this tab.</p>"; };

window.AS = { openModel };
start().catch((e) => { busy(null); status("Error: " + e.message); console.error(e); alert("Arctium Mod Manager could not start:\n" + e.message); });

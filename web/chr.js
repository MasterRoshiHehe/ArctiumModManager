// Playable character looks from the game's customization tables (the way the character screen builds them).
// ChrModel -> options -> choices -> elements -> materials (texture target + file) and geosets.
// ChrModelTextureLayer says which texture type each target paints, in which order, with which blend and on which body sections.
import { DB2 } from "./db2.js";

const FIDS = { model: 3384313, option: 3384247, choice: 3450554, element: 3512765, material: 3459652, layer: 3548976, sections: 1360263, layouts: 1360262, geoset: 3456171, req: 3450453, tfd: 982459 };
// Class filter for customization choices: 0 = show choices of every class, or a class bit (e.g. 1 << 3 = rogue).
const CLASS_BIT = 0;

export class ChrData {
  async load(readFid, cr) {
    const t = {};
    await Promise.all(Object.entries(FIDS).map(async ([k, f]) => { t[k] = new DB2(await readFid(f)); }));
    this.t = t;
    // model file -> ChrModel (through CreatureDisplayInfo/CreatureModelData from the creature tables)
    this.byModelFid = new Map();
    for (const r of t.model.rows) {
      const disp = r.v[4];
      const mid = cr.dispModel.get(disp);
      const fid = mid !== undefined ? cr.modelFid.get(mid) : undefined;
      if (fid && !this.byModelFid.has(fid)) this.byModelFid.set(fid, r.id);
    }
    this.tex = new Map(); // MaterialResourcesID -> first file
    for (const r of t.tfd.rows) if (!this.tex.has(r.v[2])) this.tex.set(r.v[2], r.id);
    this.choicesByOpt = new Map();
    for (const c of t.choice.rows) { const o = c.v[2]; if (!this.choicesByOpt.has(o)) this.choicesByOpt.set(o, []); this.choicesByOpt.get(o).push(c); }
    for (const l of this.choicesByOpt.values()) l.sort((a, b) => a.v[5] - b.v[5] || a.id - b.id);
    this.elemsByChoice = new Map();
    for (const e of t.element.rows) { const c = e.v[0]; if (!this.elemsByChoice.has(c)) this.elemsByChoice.set(c, []); this.elemsByChoice.get(c).push(e); }
    this.optsByModel = new Map();
    for (const o of t.option.rows) { const m = o.v[4]; if (!this.optsByModel.has(m)) this.optsByModel.set(m, []); this.optsByModel.get(m).push(o); }
    for (const l of this.optsByModel.values()) l.sort((a, b) => a.v[5] - b.v[5] || a.id - b.id);
    return this;
  }
  modelFor(fid) { return this.byModelFid.get(fid); }
  options(cmId) {
    return (this.optsByModel.get(cmId) || []).map((o) => ({
      id: o.id, name: this.t.option.str(o, 0) || "Option " + o.id,
      choices: (this.choicesByOpt.get(o.id) || []).map((c, k) => ({ id: c.id, name: this.t.choice.str(c, 0) || "", n: k + 1, ok: this.allowed(c) })),
    })).filter((o) => o.choices.length);
  }
  // geoset (type 0, ids 1-99) -> "N · Name" of the hair style choice that shows it
  hairNames(cmId) {
    const out = new Map();
    for (const o of this.options(cmId)) {
      if (!/hair ?style|hairstyle/i.test(o.name)) continue;
      for (const c of o.choices) for (const e of this.elemsByChoice.get(c.id) || []) {
        const g = e.v[2] && this.t.geoset.get(e.v[2]);
        if (g && g.v[0] === 0 && g.v[1] > 0 && !out.has(g.v[1])) out.set(g.v[1], `${c.n}${c.name ? " · " + c.name : ""}`);
      }
    }
    return out;
  }
  allowed(c) {
    const r = this.t.req.get(c.v[3]);
    if (!r) return true;
    const mask = r.v[2] | 0;
    return !CLASS_BIT || mask === -1 || mask === 0 || (mask & CLASS_BIT) !== 0;
  }
  defaults(cmId) {
    const sel = {};
    for (const o of this.options(cmId)) { const c = o.choices.find((x) => x.ok) || o.choices[0]; sel[o.id] = c.id; }
    return sel;
  }
  // sel: optionId -> choiceId. Returns { layout:{w,h,sections}, layers:[{type, layer, blend, mask, fid, opt}], geosets:[{type,id}] }
  resolve(cmId, sel) {
    const t = this.t, m = t.model.get(cmId);
    const layoutId = m.v[5];
    const lr = t.layouts.get(layoutId);
    const layout = { w: lr ? lr.v[0] : 2048, h: lr ? lr.v[1] : 1024, sections: new Map() };
    for (const s of t.sections.rows) if (s.rel === layoutId) layout.sections.set(s.v[1], [s.v[2], s.v[3], s.v[4], s.v[5]]);
    const layerDefs = t.layer.rows.filter((r) => r.rel === layoutId);
    const chosen = new Set(Object.values(sel));
    const optOf = new Map(Object.entries(sel).map(([o, c]) => [c, +o]));
    const layers = [], geosets = [];
    for (const c of chosen) for (const e of this.elemsByChoice.get(c) || []) {
      if (e.v[1] && !chosen.has(e.v[1])) continue;
      if (e.v[2]) { const g = t.geoset.get(e.v[2]); if (g) geosets.push({ type: g.v[0], id: g.v[1] }); }
      if (e.v[4]) {
        const mt = t.material.get(e.v[4]); if (!mt) continue;
        const fid = this.tex.get(mt.v[1]); if (!fid) continue;
        for (const l of layerDefs) if (l.v[7].includes(mt.v[0])) layers.push({ type: l.v[0], layer: l.v[1], blend: l.v[3], mask: l.v[4] >>> 0, fid, opt: optOf.get(c), target: mt.v[0] });
      }
    }
    layers.sort((a, b) => a.layer - b.layer);
    return { layout, layers, geosets };
  }
}

const OPS = { 1: "source-over", 15: "source-over", 9: "multiply", 6: "overlay", 7: "screen", 4: "multiply", 3: "lighter" };
// Paint the layers of one texture type. img(fid) -> {width,height,rgba}. extra: [{section, draw(ctx, rect)}] painted after.
export async function paintType(res, type, img, opts = {}) {
  const ls = res.layers.filter((l) => l.type === type && (!opts.skip || !opts.skip(l)));
  if (!ls.length) return null;
  const L = res.layout;
  let first = null;
  for (const l of ls) { try { first = { l, im: await img(l.fid) }; break; } catch {} }
  if (!first) return null;
  // canvas size: the layout, scaled to the detail of the first full layer
  const full = first.l.mask === 0xffffffff;
  const scale = type === 1 ? Math.min(1, full ? first.im.width / L.w : 0.5) : 1;
  const W = type === 1 ? Math.round(L.w * scale) : first.im.width, H = type === 1 ? Math.round(L.h * scale) : first.im.height;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  for (const l of ls) {
    let im; try { im = await img(l.fid); } catch { continue; }
    const src = toCanvas(im);
    g.globalCompositeOperation = OPS[l.blend] || "source-over";
    if (l.mask === 0xffffffff || type !== 1) g.drawImage(src, 0, 0, W, H);
    else for (const [st, r] of L.sections) if (l.mask & (1 << st)) { g.drawImage(src, r[0] * scale, r[1] * scale, r[2] * scale, r[3] * scale); break; }
  }
  g.globalCompositeOperation = "source-over";
  if (opts.after) await opts.after(g, (st) => { const r = L.sections.get(st); return r && r.map((x) => x * scale); });
  return c;
}
function toCanvas(img) {
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  c.getContext("2d").putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  return c;
}

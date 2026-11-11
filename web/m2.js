// M2 (MD21 chunked or legacy MD20) + .skin parser: static mesh data for preview.

function chunks(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = {};
  let p = 0;
  while (p + 8 <= u8.length) {
    const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    const size = dv.getUint32(p + 4, true);
    out[id] = u8.subarray(p + 8, p + 8 + size);
    p += 8 + size;
  }
  return out;
}

const u32list = (c) => { if (!c) return []; const dv = new DataView(c.buffer, c.byteOffset, c.byteLength); const a = []; for (let i = 0; i + 4 <= c.length; i += 4) a.push(dv.getUint32(i, true)); return a; };

export function parseM2(u8) {
  let md, ch = {};
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic === "MD21") { ch = chunks(u8); md = ch.MD21; }
  else if (magic === "MD20") md = u8;
  else throw new Error("not an M2 model (" + magic + ")");
  const dv = new DataView(md.buffer, md.byteOffset, md.byteLength);
  const arr = (o) => [dv.getUint32(o, true), dv.getUint32(o + 4, true)];
  const version = dv.getUint32(4, true);
  const [nameLen, nameOff] = arr(0x08);
  const name = new TextDecoder().decode(md.subarray(nameOff, nameOff + Math.max(0, nameLen - 1)));

  const [nv, ov] = arr(0x3c);
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), uv2 = new Float32Array(nv * 2);
  for (let i = 0; i < nv; i++) {
    const o = ov + i * 48;
    pos[i * 3] = dv.getFloat32(o, true); pos[i * 3 + 1] = dv.getFloat32(o + 4, true); pos[i * 3 + 2] = dv.getFloat32(o + 8, true);
    nrm[i * 3] = dv.getFloat32(o + 20, true); nrm[i * 3 + 1] = dv.getFloat32(o + 24, true); nrm[i * 3 + 2] = dv.getFloat32(o + 28, true);
    uv[i * 2] = dv.getFloat32(o + 32, true); uv[i * 2 + 1] = dv.getFloat32(o + 36, true);
    uv2[i * 2] = dv.getFloat32(o + 40, true); uv2[i * 2 + 1] = dv.getFloat32(o + 44, true);
  }
  const numSkins = dv.getUint32(0x44, true);

  const txid = u32list(ch.TXID);
  const [nt, ot] = arr(0x50);
  const textures = [];
  for (let i = 0; i < nt; i++) {
    const o = ot + i * 16;
    const type = dv.getUint32(o, true), flags = dv.getUint32(o + 4, true);
    const [fl, fo] = arr(o + 8);
    let file = fl > 1 ? new TextDecoder().decode(md.subarray(fo, fo + fl - 1)) : "";
    textures.push({ type, flags, fid: txid[i] || 0, file: file.replace(/\\/g, "/").toLowerCase() });
  }
  const [nm, om] = arr(0x70);
  const materials = [];
  for (let i = 0; i < nm; i++) materials.push({ flags: dv.getUint16(om + i * 4, true), blend: dv.getUint16(om + i * 4 + 2, true) });
  const lookup = (o) => { const [n, off] = arr(o); const a = []; for (let i = 0; i < n; i++) a.push(dv.getInt16(off + i * 2, true)); return a; };
  const textureLookup = lookup(0x80);
  const replaceableLookup = lookup(0x68);

  return {
    version, name, numSkins, pos, nrm, uv, uv2, textures, materials, textureLookup, replaceableLookup,
    skinFids: u32list(ch.SFID), boneFileFids: u32list(ch.BFID), chunks: Object.keys(ch),
  };
}

export function parseSkin(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== "SKIN") throw new Error("not a .skin file (" + magic + ")");
  const arr = (o) => [dv.getUint32(o, true), dv.getUint32(o + 4, true)];
  const [nvi, ovi] = arr(4), [ni, oi] = arr(12), [ns, os] = arr(28), [nb, ob] = arr(36);
  const vmap = new Uint16Array(nvi); for (let i = 0; i < nvi; i++) vmap[i] = dv.getUint16(ovi + i * 2, true);
  const tri = new Uint16Array(ni); for (let i = 0; i < ni; i++) tri[i] = dv.getUint16(oi + i * 2, true);
  const submeshes = [];
  for (let i = 0; i < ns; i++) {
    const o = os + i * 48;
    const level = dv.getUint16(o + 2, true);
    submeshes.push({ id: dv.getUint16(o, true), level, vertexStart: dv.getUint16(o + 4, true) + (level << 16), vertexCount: dv.getUint16(o + 6, true), indexStart: dv.getUint16(o + 8, true) + (level << 16), indexCount: dv.getUint16(o + 10, true) });
  }
  const batches = [];
  for (let i = 0; i < nb; i++) {
    const o = ob + i * 24;
    batches.push({ flags: u8[o], priority: dv.getInt8(o + 1), shader: dv.getUint16(o + 2, true), submesh: dv.getUint16(o + 4, true), materialIndex: dv.getUint16(o + 10, true), layer: dv.getUint16(o + 12, true), textureCount: dv.getUint16(o + 14, true), textureCombo: dv.getUint16(o + 16, true) });
  }
  return { vmap, tri, submeshes, batches };
}

// Texture type names (M2 replaceable texture types)
export const TEX_TYPES = {
  0: "Fixed file", 1: "Body skin", 2: "Cape", 6: "Hair", 8: "Extra skin / fur", 11: "Creature skin 1", 12: "Creature skin 2", 13: "Creature skin 3",
  19: "Extra skin 2", 20: "Extra skin 3", 21: "Extra skin 4",
};

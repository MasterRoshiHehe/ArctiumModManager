import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";

// A pair (or single) of synced 3D views sharing one camera.
export class Viewer {
  constructor(canvases) {
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    this.camera.position.set(0, 1, 4);
    this.views = canvases.map((canvas) => {
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 1.6));
      const d = new THREE.DirectionalLight(0xffffff, 1.6); d.position.set(2, 3, 4); scene.add(d);
      const d2 = new THREE.DirectionalLight(0xffffff, 0.6); d2.position.set(-3, 1, -2); scene.add(d2);
      const controls = new OrbitControls(this.camera, canvas);
      controls.enableDamping = false;
      controls.addEventListener("change", () => this.syncTargets(controls));
      return { canvas, renderer, scene, controls, root: null };
    });
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }
  syncTargets(src) { for (const v of this.views) if (v.controls !== src) v.controls.target.copy(src.target); }
  loop() {
    for (const v of this.views) {
      const c = v.canvas, w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) continue;
      if (c.width !== Math.floor(w * v.renderer.getPixelRatio()) || c.height !== Math.floor(h * v.renderer.getPixelRatio())) v.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      v.renderer.render(v.scene, this.camera);
    }
    requestAnimationFrame(this.loop);
  }
  clear(i) {
    const v = this.views[i];
    if (v.root) { v.scene.remove(v.root); v.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); v.root = null; }
  }
  // model: parsed M2; skin: parsed skin; texFor(textureIndex) -> THREE.Texture|null; visible(submeshId) -> bool
  setModel(i, model, skin, texFor, visible) {
    this.clear(i);
    const v = this.views[i];
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2; // WoW is Z-up
    const pos = new THREE.BufferAttribute(model.pos, 3), nrm = new THREE.BufferAttribute(model.nrm, 3), uv = new THREE.BufferAttribute(model.uv, 2);
    // global vertex buffer remapped through skin vertex list
    const nv = skin.vmap.length;
    const p = new Float32Array(nv * 3), n = new Float32Array(nv * 3), t = new Float32Array(nv * 2);
    for (let k = 0; k < nv; k++) {
      const s = skin.vmap[k];
      p[k * 3] = model.pos[s * 3]; p[k * 3 + 1] = model.pos[s * 3 + 1]; p[k * 3 + 2] = model.pos[s * 3 + 2];
      n[k * 3] = model.nrm[s * 3]; n[k * 3 + 1] = model.nrm[s * 3 + 1]; n[k * 3 + 2] = model.nrm[s * 3 + 2];
      t[k * 2] = model.uv[s * 2]; t[k * 2 + 1] = model.uv[s * 2 + 1];
    }
    const box = new THREE.Box3();
    const done = new Set();
    for (const b of skin.batches) {
      const sm = skin.submeshes[b.submesh];
      if (!sm || !visible(sm.id)) continue;
      if (b.layer > 0 && done.has(b.submesh + ":" + b.layer)) continue;
      done.add(b.submesh + ":" + b.layer);
      const mat = model.materials[b.materialIndex] || { flags: 0, blend: 0 };
      if (mat.blend === 5 || mat.blend === 6) continue; // modulate layers: skip in preview
      const texIndex = model.textureLookup[b.textureCombo];
      const tex = texFor(texIndex);
      const idx = new Uint32Array(sm.indexCount);
      for (let k = 0; k < sm.indexCount; k++) idx[k] = skin.tri[sm.indexStart + k];
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(p, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(t, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      const m = new THREE.MeshLambertMaterial({ map: tex || null, color: tex ? 0xffffff : 0x8a8f99, side: (mat.flags & 4) ? THREE.DoubleSide : THREE.FrontSide });
      if (mat.blend === 1) m.alphaTest = 0.5;
      else if (mat.blend === 2) { m.transparent = true; m.depthWrite = false; }
      else if (mat.blend >= 3) { m.transparent = true; m.blending = THREE.AdditiveBlending; m.depthWrite = false; }
      if (mat.flags & 1) { m.emissive = new THREE.Color(0x000000); }
      const mesh = new THREE.Mesh(g, m);
      mesh.renderOrder = b.priority * 10 + b.layer;
      root.add(mesh);
      g.computeBoundingBox(); box.union(g.boundingBox);
    }
    // bounding box excludes hidden parts; fall back to all verts
    if (box.isEmpty()) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(p, 3)); g.computeBoundingBox(); box.copy(g.boundingBox); }
    v.scene.add(root); v.root = root; v.box = box;
    return box;
  }
  frame(box) {
    if (!box || box.isEmpty()) return;
    // box is in WoW space (z-up); convert to view space
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const center = new THREE.Vector3(c.x, c.z, -c.y);
    const radius = Math.max(size.x, size.y, size.z) * 0.6 || 1;
    const dist = radius / Math.tan((this.camera.fov * Math.PI) / 360) * 1.1;
    this.camera.near = dist / 100; this.camera.far = dist * 100; this.camera.updateProjectionMatrix();
    // WoW models face +X; after rotation that is +X in view space. Look at the front.
    this.camera.position.set(center.x + dist, center.y + radius * 0.15, center.z);
    for (const v of this.views) { v.controls.target.copy(center); v.controls.update(); }
  }
  setBackground(color) { for (const v of this.views) v.scene.background = color ? new THREE.Color(color) : null; }
}

export function dataTexture(img, wrapS = true, wrapT = true) {
  const t = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = wrapS ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = wrapT ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.flipY = false; t.needsUpdate = true;
  return t;
}
export function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace; t.flipY = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true;
  return t;
}

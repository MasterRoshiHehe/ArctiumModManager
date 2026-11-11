import fs from "fs"; import path from "path"; import zlib from "zlib";
export function nodeIO(root) {
  return {
    async read(rel, off, len) {
      const p = path.join(root, rel);
      if (off === undefined) return new Uint8Array(fs.readFileSync(p));
      const fd = fs.openSync(p, "r"); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); fs.closeSync(fd); return new Uint8Array(b.buffer, b.byteOffset, len);
    },
    async readText(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); },
    async list(rel) { return fs.readdirSync(path.join(root, rel)); },
    async inflate(u8) { return new Uint8Array(zlib.inflateSync(u8)); },
  };
}

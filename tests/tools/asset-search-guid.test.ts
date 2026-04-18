import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import { PakVirtualFS } from "../../src/pak/vfs.js";
import { extractGuidsFromPakCatalogs } from "../../src/tools/asset-search.js";

// Synthetic pak builder — same helper as tests/pak/vfs.test.ts.
// Copy-pasted rather than imported to keep the test file self-contained.
function buildTestPak(files: Array<{ path: string; content: string; compress: boolean }>): Buffer {
  interface TreeFile { name: string; offset: number; compressedLen: number; decompressedLen: number; compressed: boolean }
  interface TreeDir { name: string; children: Map<string, TreeDir | TreeFile> }
  const dataChunks: Buffer[] = [];
  let dataOffset = 0;
  const root: TreeDir = { name: "", children: new Map() };
  for (const file of files) {
    const raw = Buffer.from(file.content, "utf-8");
    const stored = file.compress ? deflateRawSync(raw) : raw;
    const parts = file.path.split("/");
    const fileName = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      let child = dir.children.get(part);
      if (!child || !("children" in child)) { child = { name: part, children: new Map() }; dir.children.set(part, child); }
      dir = child as TreeDir;
    }
    dir.children.set(fileName, { name: fileName, offset: dataOffset, compressedLen: stored.length, decompressedLen: raw.length, compressed: file.compress });
    dataChunks.push(stored); dataOffset += stored.length;
  }
  function serializeEntry(entry: TreeDir | TreeFile): Buffer {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const parts: Buffer[] = []; const header = Buffer.alloc(2);
    if ("children" in entry) {
      header.writeUInt8(0, 0); header.writeUInt8(nameBuf.length, 1); parts.push(header, nameBuf);
      const countBuf = Buffer.alloc(4); countBuf.writeUInt32LE(entry.children.size, 0); parts.push(countBuf);
      for (const child of entry.children.values()) parts.push(serializeEntry(child));
    } else {
      header.writeUInt8(1, 0); header.writeUInt8(nameBuf.length, 1); parts.push(header, nameBuf);
      const meta = Buffer.alloc(24);
      meta.writeUInt32LE(entry.offset, 0); meta.writeUInt32LE(entry.compressedLen, 4);
      meta.writeUInt32LE(entry.decompressedLen, 8); meta.writeUInt32LE(0, 12);
      meta.writeUInt16LE(0, 16); meta.writeUInt8(entry.compressed ? 1 : 0, 18);
      meta.writeUInt8(entry.compressed ? 6 : 0, 19); meta.writeUInt32LE(0, 20);
      parts.push(meta);
    }
    return Buffer.concat(parts);
  }
  const fileTreeBuf = serializeEntry(root);
  const dataPayload = Buffer.concat(dataChunks);
  const headLen = 0x1c;
  const headPayload = Buffer.alloc(headLen);
  const totalPayload = 4 + 8 + headLen + 8 + dataPayload.length + 8 + fileTreeBuf.length;
  const buf = Buffer.alloc(8 + totalPayload);
  let pos = 0;
  buf.write("FORM", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(totalPayload, pos); pos += 4;
  buf.write("PAC1", pos, 4, "ascii"); pos += 4;
  buf.write("HEAD", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(headLen, pos); pos += 4;
  headPayload.copy(buf, pos); pos += headLen;
  buf.write("DATA", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(dataPayload.length, pos); pos += 4;
  dataPayload.copy(buf, pos); pos += dataPayload.length;
  buf.write("FILE", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(fileTreeBuf.length, pos); pos += 4;
  fileTreeBuf.copy(buf, pos);
  return buf;
}

const TEST_DIR = join(tmpdir(), "enfusion-mcp-guid-test-" + process.pid);
const GAME_DIR = join(TEST_DIR, "game");
const ADDONS_DIR = join(GAME_DIR, "addons");

beforeAll(() => {
  mkdirSync(ADDONS_DIR, { recursive: true });
  const catalogContent = `Config {
 items {
  EntityCatalogItem {
   m_sEntityPrefab "{AABBCCDDEEFF0011}Prefabs/RHS/Rifle_AK74.et"
  }
 }
}`;
  const pak = buildTestPak([
    { path: "Configs/EntityCatalog/weapons.conf", content: catalogContent, compress: false },
    { path: "Prefabs/RHS/Rifle_AK74.et", content: "Rifle_AK74", compress: false },
  ]);
  writeFileSync(join(ADDONS_DIR, "rhs.pak"), pak);
  (PakVirtualFS as any).instance = null;
  (PakVirtualFS as any).instanceKey = null;
});

afterAll(() => {
  (PakVirtualFS as any).instance = null;
  (PakVirtualFS as any).instanceKey = null;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("extractGuidsFromPakCatalogs", () => {
  it("extracts GUIDs from entity catalog .conf files inside paks", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const guids = extractGuidsFromPakCatalogs(vfs);
    expect(guids.get("prefabs/rhs/rifle_ak74.et")).toBe("AABBCCDDEEFF0011");
  });
});

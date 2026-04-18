# Third-Party Mod Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the `enfusion-mcp` to discover, browse, read, and search `.pak` files from user-installed Reforger mods — not just the base game — via a configurable list of additional pak-root directories.

**Architecture:**
- Config layer: new `modPaths: string[]` field on `Config`, with OS-relative discovery defaults under `homedir()`, JSON config support, and `ENFUSION_MOD_PATHS` env var override.
- VFS layer: `PakVirtualFS.get()` accepts an optional `modPaths` array; the pak-scan loop is extracted into a `scanPakRoot()` helper that runs once per root. Base game paks are scanned first so they win on collisions.
- Tool layer: thread `config.modPaths` through the three consuming tools (`game_browse`, `game_read`, `asset_search`); cache keys extended to include modPaths so changes invalidate correctly.
- GUID index: extend `asset_search` to walk entity-catalog `.conf` files that live inside pak archives (workshop mods store them that way), not just loose files.

**Tech Stack:** TypeScript (Node 20+), Vitest, Node built-ins (`fs`, `os`, `path`, `zlib`). No new runtime deps.

---

## File Structure

### New Files
- `tests/config.test.ts` -- Vitest coverage for config defaults, discovery, env var override
- `tests/tools/asset-search-guid.test.ts` -- Verifies GUIDs from pak-internal entity catalogs

### Modified Files
- `src/config.ts` -- Add `modPaths` field, `ENFUSION_MOD_PATHS` env var, `discoverDefaultModPaths()` helper, startup log
- `src/pak/vfs.ts` -- `PakVirtualFS.get()` accepts optional `modPaths`; extract `scanPakRoot()` helper; cache key includes modPaths
- `src/tools/game-browse.ts` -- Pass `config.modPaths` to `PakVirtualFS.get()`; update tool description
- `src/tools/game-read.ts` -- Pass `config.modPaths` to `PakVirtualFS.get()`; update tool description
- `src/tools/asset-search.ts` -- Pass modPaths; extend `buildGuidIndex()` to walk pak-internal catalogs; update cache key
- `tests/pak/vfs.test.ts` -- Add multi-root merge tests
- `enfusion-mcp.config.example.json` -- Show `modPaths` example
- `README.md` -- Document mod-path config and discovery precedence

---

## Task Breakdown

### Task 1: Add `modPaths` to Config with Discovery Defaults

**Files:**
- Modify: `src/config.ts` (Config interface, DEFAULTS, loadConfig)
- Create: `tests/config.test.ts`

- [ ] **Step 1: Add `modPaths` field to the Config interface**

In `src/config.ts`, add the field to the `Config` interface (currently ending around line 33):

```typescript
  /** Additional addon roots to merge into PakVirtualFS (workshop mods, extracted mods, etc.).
   *  Each entry is a directory containing .pak files (or subdirectories of .pak files),
   *  same shape as gamePath/addons. Discovered from default locations and overridable via
   *  ENFUSION_MOD_PATHS env var (comma- or semicolon-separated). */
  modPaths: string[];
```

- [ ] **Step 2: Add the discovery helper**

Above the `DEFAULTS` constant (around line 37), add:

```typescript
/** Probe well-known Reforger mod-pak locations under the user's home dir.
 *  Returns only paths that exist, so CI/containers without Reforger installed
 *  get an empty list, not fake entries. */
function discoverDefaultModPaths(): string[] {
  const home = homedir();
  const candidates = [
    join(home, "Documents", "My Games", "ArmaReforger", "addons"),
    join(home, "Documents", "My Games", "ArmaReforgerWorkbench", "addons"),
  ];
  return candidates.filter((p) => existsSync(p));
}
```

Then add `modPaths: discoverDefaultModPaths(),` to the `DEFAULTS` object (order doesn't matter, but keep it near `extractedPath` for readability).

- [ ] **Step 3: Add env var parsing in `loadConfig`**

Inside `loadConfig()`, after the `ENFUSION_DEFAULT_MOD` block (currently around line 119-121), add:

```typescript
  if (process.env.ENFUSION_MOD_PATHS) {
    config.modPaths = process.env.ENFUSION_MOD_PATHS
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
```

- [ ] **Step 4: Add startup log**

Immediately before the `return config;` line at the end of `loadConfig()`, add:

```typescript
  if (config.modPaths.length > 0) {
    logger.info(`Mod paths (${config.modPaths.length}): ${config.modPaths.join(", ")}`);
  } else {
    logger.debug("No mod paths configured or discovered");
  }
```

- [ ] **Step 5: Write tests covering defaults, discovery, and env var parsing**

Create `tests/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "ENFUSION_WORKBENCH_PATH",
  "ENFUSION_PROJECT_PATH",
  "ENFUSION_GAME_PATH",
  "ENFUSION_EXTRACTED_PATH",
  "ENFUSION_MCP_DATA_DIR",
  "ENFUSION_WORKBENCH_HOST",
  "ENFUSION_WORKBENCH_PORT",
  "ENFUSION_DEFAULT_MOD",
  "ENFUSION_MOD_PATHS",
];

describe("loadConfig — modPaths", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults modPaths to [] when nothing is configured and no default dirs exist", () => {
    const scratch = join(tmpdir(), "enfusion-cfg-test-" + process.pid);
    mkdirSync(scratch, { recursive: true });
    process.env.HOME = scratch;
    process.env.USERPROFILE = scratch;
    try {
      const cfg = loadConfig();
      expect(cfg.modPaths).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("discovers default mod paths when they exist under homedir", () => {
    const scratch = join(tmpdir(), "enfusion-cfg-test-home-" + process.pid);
    const gameAddons = join(scratch, "Documents", "My Games", "ArmaReforger", "addons");
    const wbAddons = join(scratch, "Documents", "My Games", "ArmaReforgerWorkbench", "addons");
    mkdirSync(gameAddons, { recursive: true });
    mkdirSync(wbAddons, { recursive: true });
    process.env.HOME = scratch;
    process.env.USERPROFILE = scratch;
    try {
      const cfg = loadConfig();
      expect(cfg.modPaths).toContain(gameAddons);
      expect(cfg.modPaths).toContain(wbAddons);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("ENFUSION_MOD_PATHS env var overrides discovery (semicolon + comma separators)", () => {
    process.env.ENFUSION_MOD_PATHS = "/a/one,/b/two;/c/three";
    const cfg = loadConfig();
    expect(cfg.modPaths).toEqual(["/a/one", "/b/two", "/c/three"]);
  });

  it("trims whitespace and ignores empty entries in ENFUSION_MOD_PATHS", () => {
    process.env.ENFUSION_MOD_PATHS = " /a , , /b ";
    const cfg = loadConfig();
    expect(cfg.modPaths).toEqual(["/a", "/b"]);
  });
});
```

- [ ] **Step 6: Run the new tests**

Run: `npx vitest run tests/config.test.ts`
Expected: all four cases PASS.

**Commit point:** `feat(config): add modPaths with discovery defaults and env var override`

---

### Task 2: Refactor `PakVirtualFS` to Accept Multiple Addon Roots

**Files:**
- Modify: `src/pak/vfs.ts` (invalidate, get, singleton key)
- Modify: `tests/pak/vfs.test.ts`

- [ ] **Step 1: Extract the pak-scan loop into a helper**

In `src/pak/vfs.ts`, add this function at the bottom of the file (after the existing `normalizePath` helper):

```typescript
/** Scan a directory for .pak files (top level plus one level deep).
 *  Returns sorted absolute paths; empty array if the directory does not exist. */
function scanPakRoot(addonsPath: string): string[] {
  if (!existsSync(addonsPath)) return [];
  const found: string[] = [];
  try {
    const topEntries = readdirSync(addonsPath, { withFileTypes: true });
    for (const e of topEntries) {
      if (e.isFile() && extname(e.name).toLowerCase() === ".pak") {
        found.push(join(addonsPath, e.name));
      }
    }
    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue;
      try {
        const subEntries = readdirSync(join(addonsPath, entry.name), { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isFile() && extname(sub.name).toLowerCase() === ".pak") {
            found.push(join(addonsPath, entry.name, sub.name));
          }
        }
      } catch {
        // Skip unreadable subdirectories
      }
    }
  } catch {
    return [];
  }
  found.sort();
  return found;
}
```

- [ ] **Step 2: Update `PakVirtualFS.get()` signature and internals**

Replace the current `static get(gamePath: string)` method with:

```typescript
  /** Key used for cache invalidation: combines gamePath and modPaths deterministically. */
  private static instanceKey: string | null = null;

  static invalidate(): void {
    PakVirtualFS.instance = null;
    PakVirtualFS.instanceKey = null;
  }

  /**
   * Get or create the singleton VFS for the given game path + optional mod paths.
   * Base game addons are scanned first; mod roots are scanned in provided order.
   * Precedence on duplicate virtual paths: first pak in scan order wins
   * (so base game takes precedence on collisions).
   * Returns null if no .pak files are found anywhere.
   */
  static get(gamePath: string, modPaths: string[] = []): PakVirtualFS | null {
    const key = `${gamePath}|${modPaths.join("|")}`;
    if (PakVirtualFS.instance && PakVirtualFS.instanceKey === key) {
      return PakVirtualFS.instance;
    }

    const baseAddons = join(gamePath, "addons");
    const pakFiles = [
      ...scanPakRoot(baseAddons),
      ...modPaths.flatMap((p) => scanPakRoot(p)),
    ];

    if (pakFiles.length === 0) return null;

    const vfs = new PakVirtualFS(pakFiles);
    PakVirtualFS.instance = vfs;
    PakVirtualFS.instanceKey = key;
    return vfs;
  }
```

Also remove the now-unused `instanceGamePath` static field (around line 34).

- [ ] **Step 3: Add multi-root merge tests**

Append to `tests/pak/vfs.test.ts` (after the existing `describe` block):

```typescript
describe("PakVirtualFS — multi-root merging", () => {
  const MOD_TEST_DIR = join(tmpdir(), "enfusion-mcp-vfs-mod-test-" + process.pid);
  const MOD_GAME_DIR = join(MOD_TEST_DIR, "game");
  const MOD_GAME_ADDONS = join(MOD_GAME_DIR, "addons");
  const MOD_ROOT = join(MOD_TEST_DIR, "mods");

  beforeAll(() => {
    mkdirSync(MOD_GAME_ADDONS, { recursive: true });
    mkdirSync(MOD_ROOT, { recursive: true });

    const basePak = buildTestPak([
      { path: "Prefabs/vanilla.et", content: "vanilla", compress: false },
    ]);
    writeFileSync(join(MOD_GAME_ADDONS, "base.pak"), basePak);

    const modPak = buildTestPak([
      { path: "Prefabs/rhs_weapon.et", content: "rhs", compress: false },
    ]);
    writeFileSync(join(MOD_ROOT, "rhs.pak"), modPak);

    (PakVirtualFS as any).instance = null;
    (PakVirtualFS as any).instanceKey = null;
  });

  afterAll(() => {
    (PakVirtualFS as any).instance = null;
    (PakVirtualFS as any).instanceKey = null;
    rmSync(MOD_TEST_DIR, { recursive: true, force: true });
  });

  it("indexes files from both base game and mod roots", () => {
    const vfs = PakVirtualFS.get(MOD_GAME_DIR, [MOD_ROOT])!;
    expect(vfs).not.toBeNull();
    expect(vfs.exists("Prefabs/vanilla.et")).toBe(true);
    expect(vfs.exists("Prefabs/rhs_weapon.et")).toBe(true);
  });

  it("base game paks take precedence on name collision", () => {
    const COLLIDE_DIR = join(MOD_TEST_DIR, "collide");
    mkdirSync(COLLIDE_DIR, { recursive: true });
    const overridePak = buildTestPak([
      { path: "Prefabs/vanilla.et", content: "overridden-by-mod", compress: false },
    ]);
    writeFileSync(join(COLLIDE_DIR, "override.pak"), overridePak);

    (PakVirtualFS as any).instance = null;
    (PakVirtualFS as any).instanceKey = null;

    const vfs = PakVirtualFS.get(MOD_GAME_DIR, [COLLIDE_DIR])!;
    expect(vfs.readTextFile("Prefabs/vanilla.et")).toBe("vanilla");
  });

  it("caches per (gamePath, modPaths) key", () => {
    (PakVirtualFS as any).instance = null;
    (PakVirtualFS as any).instanceKey = null;

    const a = PakVirtualFS.get(MOD_GAME_DIR, [MOD_ROOT]);
    const b = PakVirtualFS.get(MOD_GAME_DIR, [MOD_ROOT]);
    expect(a).toBe(b);

    const c = PakVirtualFS.get(MOD_GAME_DIR, []);
    expect(c).not.toBe(a);
  });
});
```

Also update the existing `beforeAll`/`afterAll` singleton-reset blocks (lines 125-126 and 131-132) to clear `instanceKey` instead of `instanceGamePath`.

- [ ] **Step 4: Run the VFS test suite**

Run: `npx vitest run tests/pak/vfs.test.ts`
Expected: all tests PASS — existing tests still green, three new tests also green.

**Commit point:** `feat(pak): PakVirtualFS accepts mod pak roots alongside base game`

---

### Task 3: Thread `modPaths` Through Game Tools

**Files:**
- Modify: `src/tools/game-browse.ts`
- Modify: `src/tools/game-read.ts`
- Modify: `src/tools/asset-search.ts`

- [ ] **Step 1: Update `game_browse` call site and description**

In `src/tools/game-browse.ts`, find the line (around line 66):

```typescript
          const pakVfs = PakVirtualFS.get(config.gamePath);
```

Replace with:

```typescript
          const pakVfs = PakVirtualFS.get(config.gamePath, config.modPaths);
```

Update the tool description (around line 18) from:

```typescript
        "Browse base game data files (scripts, prefabs, configs). " +
        "Shows both unpacked files and contents of .pak archives transparently. " +
```

to:

```typescript
        "Browse game data files (scripts, prefabs, configs) from the base game " +
        "and any configured mod paks (workshop mods, etc.). " +
        "Shows both unpacked files and contents of .pak archives transparently. " +
```

- [ ] **Step 2: Update `game_read` call site and description**

In `src/tools/game-read.ts`, find the line (around line 99):

```typescript
        const pakVfs = PakVirtualFS.get(config.gamePath);
```

Replace with:

```typescript
        const pakVfs = PakVirtualFS.get(config.gamePath, config.modPaths);
```

Update the tool description (around line 21) from:

```typescript
        "Read a file from the base game data. " +
```

to:

```typescript
        "Read a file from the base game data or from any configured mod paks. " +
```

- [ ] **Step 3: Update `asset_search` call site, cache, and description**

In `src/tools/asset-search.ts`, find the line (around line 134 inside `buildIndex`):

```typescript
    const pakVfs = PakVirtualFS.get(gamePath);
```

Replace with:

```typescript
    const pakVfs = PakVirtualFS.get(gamePath, modPaths);
```

Change the `buildIndex` signature (around line 83) from:

```typescript
function buildIndex(basePath: string, gamePath: string): AssetEntry[] {
```

to:

```typescript
function buildIndex(basePath: string, gamePath: string, modPaths: string[]): AssetEntry[] {
```

Update the cache variables (around line 40-42):

```typescript
let cachedIndex: AssetEntry[] | null = null;
let cachedBasePath: string | null = null;
let cachedModPaths: string = "";
let cachedGuidDiag = "";
```

Update `invalidateAssetCache` (around line 167-171):

```typescript
export function invalidateAssetCache(): void {
  cachedIndex = null;
  cachedBasePath = null;
  cachedModPaths = "";
  cachedGuidDiag = "";
}
```

Update `getIndex` (around line 173-179):

```typescript
function getIndex(basePath: string, gamePath: string, modPaths: string[]): AssetEntry[] {
  const modKey = modPaths.join("|");
  if (cachedIndex && cachedBasePath === basePath && cachedModPaths === modKey) {
    return cachedIndex;
  }
  cachedIndex = buildIndex(basePath, gamePath, modPaths);
  cachedBasePath = basePath;
  cachedModPaths = modKey;
  return cachedIndex;
}
```

Update the `getIndex` call inside the tool handler (around line 213):

```typescript
        const index = getIndex(basePath, config.gamePath, config.modPaths);
```

Update the tool description (around line 188) to mention mods:

```typescript
        "Search for game assets (prefabs, models, textures, scripts, configs) by name " +
        "across the base game and any configured mod paks. " +
```

- [ ] **Step 4: Run the full test suite to verify no regressions**

Run: `npx vitest run`
Expected: all tests PASS.

**Commit point:** `feat(tools): thread modPaths through game_browse, game_read, asset_search`

---

### Task 4: Extend GUID Index to Read Pak-Internal Entity Catalogs

**Files:**
- Modify: `src/tools/asset-search.ts` (the `buildIndex` function, around lines 50-130)
- Create: `tests/tools/asset-search-guid.test.ts`

- [ ] **Step 1: Add the pak-catalog GUID extractor**

In `src/tools/asset-search.ts`, below the existing `buildGuidIndex` function (around line 80), add:

```typescript
/** Walk VFS for entity-catalog .conf files and extract {GUID}path.et pairs.
 *  Workshop mods pack their entity catalogs inside .pak files, so the loose-file
 *  walker in buildGuidIndex misses them. This complements it by reading the VFS. */
export function extractGuidsFromPakCatalogs(
  vfs: { allFilePaths(): string[]; readTextFile(p: string): string }
): Map<string, string> {
  const guidMap = new Map<string, string>();
  const GUID_PATTERN = /\{([0-9A-Fa-f]{16})\}([^\s"]+\.et)/g;
  let catalogsRead = 0;

  for (const path of vfs.allFilePaths()) {
    const lower = path.toLowerCase();
    if (!lower.endsWith(".conf")) continue;
    if (!lower.includes("entitycatalog")) continue;

    catalogsRead++;
    let content: string;
    try {
      content = vfs.readTextFile(path);
    } catch (e) {
      logger.warn(`GUID index (VFS): failed to read ${path}: ${e}`);
      continue;
    }

    let match: RegExpExecArray | null;
    GUID_PATTERN.lastIndex = 0;
    while ((match = GUID_PATTERN.exec(content)) !== null) {
      const guid = match[1].toUpperCase();
      const prefabPath = match[2].replace(/\\/g, "/");
      const key = prefabPath.toLowerCase();
      if (!guidMap.has(key)) {
        guidMap.set(key, guid);
      }
    }
  }

  logger.info(`GUID index (VFS): ${guidMap.size} GUIDs from ${catalogsRead} pak catalogs`);
  return guidMap;
}
```

- [ ] **Step 2: Integrate the extractor into `buildIndex`**

Inside `buildIndex`, **after** the `buildGuidIndex(basePath)` call and **before** the "Add entries from .pak files" block (around line 119), merge pak-catalog GUIDs into `guidMap`:

```typescript
  // Merge pak-catalog GUIDs on top of loose-catalog GUIDs (loose wins on duplicates).
  try {
    const pakVfs = PakVirtualFS.get(gamePath, modPaths);
    if (pakVfs && guidMap) {
      const pakGuids = extractGuidsFromPakCatalogs(pakVfs);
      for (const [path, guid] of pakGuids) {
        if (!guidMap.has(path)) {
          guidMap.set(path, guid);
        }
      }
    }
  } catch (e) {
    logger.warn(`Failed to merge pak-catalog GUIDs: ${e}`);
  }
```

Update `cachedGuidDiag` after this block:

```typescript
  if (guidMap) {
    cachedGuidDiag = `${guidMap.size} GUIDs total (loose + pak catalogs)`;
  }
```

- [ ] **Step 3: Write the pak-catalog GUID test**

Create `tests/tools/asset-search-guid.test.ts`:

```typescript
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
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: all tests PASS, including the new `extractGuidsFromPakCatalogs` case.

**Commit point:** `feat(asset-search): extract GUIDs from pak-internal entity catalogs`

---

### Task 5: Documentation

**Files:**
- Modify: `enfusion-mcp.config.example.json`
- Modify: `README.md`

- [ ] **Step 1: Update the config example**

Replace the contents of `enfusion-mcp.config.example.json` with:

```json
{
  "workbenchPath": "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools",
  "projectPath": "C:\\Users\\YourName\\Documents\\My Games\\ArmaReforgerWorkbench\\addons",
  "modPaths": [
    "C:\\Users\\YourName\\Documents\\My Games\\ArmaReforger\\addons",
    "C:\\Users\\YourName\\Documents\\My Games\\ArmaReforgerWorkbench\\addons"
  ]
}
```

- [ ] **Step 2: Add a Mods section to the README**

In `README.md`, after the existing configuration section (search for `ENFUSION_WORKBENCH_PATH` to find the env var table), add a new subsection:

````markdown
### Third-party mod support

`enfusion-mcp` can browse, read, and search `.pak` files from installed workshop mods in addition to the base game. Mod paks are layered on top of the base game — base game paks take precedence on any path collisions.

**Automatic discovery (default):** On startup, `enfusion-mcp` probes these paths and uses whichever exist:
- `~/Documents/My Games/ArmaReforger/addons` — game client's workshop cache
- `~/Documents/My Games/ArmaReforgerWorkbench/addons` — Workbench workshop cache

**Explicit override:** Set via either
- Env var `ENFUSION_MOD_PATHS` (comma- or semicolon-separated):
  ```bash
  ENFUSION_MOD_PATHS="/path/to/mods1,/path/to/mods2"
  ```
- JSON config `modPaths` array (see `enfusion-mcp.config.example.json`).

Explicit config overrides discovery. The resolved list is logged at startup.
````

**Commit point:** `docs: document modPaths config and discovery precedence`

---

## Summary of all commits

1. `feat(config): add modPaths with discovery defaults and env var override`
2. `feat(pak): PakVirtualFS accepts mod pak roots alongside base game`
3. `feat(tools): thread modPaths through game_browse, game_read, asset_search`
4. `feat(asset-search): extract GUIDs from pak-internal entity catalogs`
5. `docs: document modPaths config and discovery precedence`

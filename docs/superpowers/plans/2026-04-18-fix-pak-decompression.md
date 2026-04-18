# Fix: `game_read` zlib Failures on Real Workshop Paks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `PakVirtualFS.readFile` successfully decompress entries from real Enfusion workshop paks (RHS, RealisticCombatDrones, Salami, etc.) that currently fail with zlib errors.

**Architecture:** The current implementation assumes every compressed entry is a raw DEFLATE stream and calls `inflateRawSync(buf)` on exactly `compressedLen` bytes starting at `dataStart + entry.offset` (`src/pak/vfs.ts:131-159`). Real paks fail with three distinct zlib errors — `invalid stored block lengths`, `invalid distance too far back`, `invalid block type` — which each point to "the bytes we hand to inflate aren't what raw inflate expects." The root cause is unknown, so this plan is **diagnose-then-fix**: Phase 1 is a standalone diagnostic that runs against a real failing pak and identifies the format discrepancy; Phase 2 branches on that finding; Phase 3 adds a regression fixture.

**Tech Stack:** TypeScript, Node `node:zlib` (possibly `node:stream`), `vitest`. May add `lz4-napi` or similar if Phase 1 shows LZ4/zstd framing.

**Issue tracker:** https://github.com/Wicaeed/enfusion-mcp-BK/issues/11

---

## Pre-Flight: Confirm Local Repro

**Files:**
- Read-only: `src/pak/vfs.ts:131-159`, `src/pak/reader.ts`

- [ ] **Step 1: Verify a failing pak is accessible on disk**

Run:
```bash
ls "/mnt/c/Users/wicae/Documents/My Games/ArmaReforger/addons/RealisticCombatDrones_65AD60E204191D37/data.pak"
ls "/mnt/c/Users/wicae/Documents/My Games/ArmaReforger/addons/RHS-StatusQuo_595F2BF2F44836FB/data.pak"
```
Expected: both paths exist, non-zero size.

- [ ] **Step 2: Reproduce the failure with a minimal script**

Create `scripts/repro-pak-read.ts` (outside src, one-shot; delete after plan completes):

```typescript
import { PakVirtualFS } from "../src/pak/vfs.js";

const gamePath = "/mnt/c/Program Files (x86)/Steam/steamapps/common/Arma Reforger";
const modPaths = ["/mnt/c/Users/wicae/Documents/My Games/ArmaReforger/addons"];
const vfs = PakVirtualFS.get(gamePath, modPaths);
if (!vfs) { throw new Error("No VFS"); }

const paths = [
  "scripts/Game/Drone/DroneComponents/SAL_DroneSignalComponent.c",
  "scripts/Game/Drone/DroneComponents/SAL_DroneJammerComponent.c",
];
for (const p of paths) {
  try {
    const buf = vfs.readFile(p);
    console.log(`OK   ${p}  (${buf.length} bytes)`);
  } catch (e) {
    console.log(`FAIL ${p}  ${(e as Error).message}`);
  }
}
```

Run:
```bash
npx tsx scripts/repro-pak-read.ts
```
Expected: at least one `FAIL` line with a zlib error matching the issue. If everything passes, stop — the bug may already be fixed or dependent on environment, which must be resolved before continuing.

---

## Phase 1: Diagnose the Format Discrepancy

**Files:**
- Create: `scripts/diagnose-pak-entry.ts` (one-shot diagnostic; delete in Phase 3)

Goal of this phase: produce a written finding ("real paks use X, reader assumes Y") that pins the fix to exactly one branch in Phase 2.

### Task 1: Dump raw bytes and alternate-decompress a failing entry

- [ ] **Step 1: Write the diagnostic script**

Create `scripts/diagnose-pak-entry.ts`:

```typescript
import { openSync, readSync, closeSync } from "node:fs";
import { inflateRawSync, inflateSync, unzipSync } from "node:zlib";
import { parsePakIndex } from "../src/pak/vfs.js"; // re-export if needed
// Direct import:
import { parsePakIndex as parseIdx } from "../src/pak/reader.js";

const PAK = "/mnt/c/Users/wicae/Documents/My Games/ArmaReforger/addons/RealisticCombatDrones_65AD60E204191D37/data.pak";
const TARGET = "scripts/Game/Drone/DroneComponents/SAL_DroneSignalComponent.c";

const idx = parseIdx(PAK);

function findFile(dir: any, parts: string[]): any {
  if (parts.length === 0) return null;
  const child = dir.children.get(parts[0]);
  if (!child) return null;
  if (parts.length === 1) return child.kind === "file" ? child : null;
  return child.kind === "dir" ? findFile(child, parts.slice(1)) : null;
}

const entry = findFile(idx.root, TARGET.split("/"));
if (!entry) { throw new Error("target not found in pak tree"); }
console.log("Entry:", {
  compressed: entry.compressed,
  compressedLen: entry.compressedLen,
  decompressedLen: entry.decompressedLen,
  offset: entry.offset,
  absPos: idx.dataStart + entry.offset,
});

const fd = openSync(PAK, "r");
const buf = Buffer.alloc(entry.compressedLen);
readSync(fd, buf, 0, entry.compressedLen, idx.dataStart + entry.offset);
closeSync(fd);

console.log("First 32 bytes (hex):", buf.subarray(0, 32).toString("hex"));
console.log("First 2 bytes:", buf[0].toString(16), buf[1].toString(16));

// Known magic bytes to check:
//   0x78 0x01/0x9C/0xDA  = zlib wrapped deflate
//   0x1F 0x8B            = gzip
//   0x04 0x22 0x4D 0x18  = LZ4 frame
//   0x28 0xB5 0x2F 0xFD  = zstd frame
//   0x02 0x21            = LZ4 legacy

// Try each decompressor at several offsets:
for (const startOff of [0, 4, 8, 16]) {
  const slice = buf.subarray(startOff);
  for (const [name, fn] of [
    ["inflateRaw", inflateRawSync],
    ["inflate",    inflateSync],
    ["unzip",      unzipSync],
  ] as const) {
    try {
      const out = fn(slice);
      console.log(`SUCCESS fn=${name} offset=+${startOff} outLen=${out.length} (expected ${entry.decompressedLen})`);
      console.log("  first 80 bytes as UTF-8:", out.subarray(0, 80).toString("utf-8"));
    } catch (e) {
      console.log(`  fail fn=${name} offset=+${startOff}: ${(e as Error).message}`);
    }
  }
}
```

- [ ] **Step 2: Run the diagnostic**

Run: `npx tsx scripts/diagnose-pak-entry.ts`

Expected one of three outcomes, each locking Phase 2 to a specific branch:

- **Branch A — Wrong inflate variant.** `SUCCESS fn=inflate offset=+0 ...` (or `unzip`). Means real paks use zlib-wrapped deflate, not raw; the test fixtures round-trip because they use `deflateRawSync` but real Enfusion paks use `deflateSync`. First two bytes will typically be `78 01`, `78 9C`, or `78 DA`.
- **Branch B — Per-entry header bytes.** `SUCCESS fn=inflateRaw offset=+N ...` for some N > 0. Means each compressed entry has an N-byte header (checksum, block-length, or framing) the reader must skip.
- **Branch C — Different algorithm.** No `SUCCESS` line. First bytes match LZ4 (`04 22 4D 18` / `02 21`) or zstd (`28 B5 2F FD`). Fix requires a new decoder library.

- [ ] **Step 3: Record the finding**

Append to this plan under a new heading `## Phase 1 Finding:` with:
- The exact hex of the first 16 bytes
- Which branch (A/B/C) is confirmed
- For B: the exact offset N
- For C: the algorithm identified

This finding is the input to Phase 2. Do not proceed to Phase 2 without it.

---

## Phase 2: Implement the Fix

Only execute the branch matching the Phase 1 finding. Strike through the branches that do not apply.

### Branch A — Wrong inflate variant

**Files:**
- Modify: `src/pak/vfs.ts:152-154`
- Test: `tests/pak/vfs.test.ts`

- [ ] **A1: Write a failing unit test that uses zlib-wrapped (not raw) deflate**

Insert in `tests/pak/vfs.test.ts` (after the existing "reads compressed file" test):

```typescript
it("reads compressed file produced with zlib-wrapped deflate", () => {
  const { deflateSync } = require("node:zlib");
  const raw = Buffer.from("zlib-wrapped payload for real Enfusion paks", "utf-8");
  const stored = deflateSync(raw); // wrapped, not raw
  const pak = buildFixturePak([{ name: "wrapped.c", payload: stored, rawLen: raw.length, compressed: true }]);
  const vfs = openVfsFromBuffer(pak);
  expect(vfs.readTextFile("wrapped.c")).toBe(raw.toString("utf-8"));
});
```

(If `buildFixturePak` / `openVfsFromBuffer` helpers don't exist as shown, adapt to the existing helpers in the same file. Do not rewrite the file scaffolding — inline into existing `describe` block.)

- [ ] **A2: Run the test to verify it fails**

Run: `npx vitest run tests/pak/vfs.test.ts -t "zlib-wrapped"`
Expected: FAIL with a zlib error from `inflateRawSync`.

- [ ] **A3: Implement the minimal fix**

Edit `src/pak/vfs.ts:152-154`. Replace:

```typescript
      if (entry.compressed) {
        return inflateRawSync(buf);
      }
```

with:

```typescript
      if (entry.compressed) {
        // Real Enfusion paks use zlib-wrapped deflate; `unzipSync` accepts both
        // wrapped and gzip, so it's the safest single entry point.
        return unzipSync(buf);
      }
```

Add the import at the top:
```typescript
import { unzipSync } from "node:zlib";
```
and remove the now-unused `inflateRawSync` import.

- [ ] **A4: Run both new and existing tests**

Run: `npx vitest run tests/pak/vfs.test.ts`
Expected: all tests pass, including the existing "reads compressed file" (`unzipSync` handles raw deflate via zlib auto-detect when the input is valid — if it doesn't, fall back to try-raw-then-wrapped; see A5).

- [ ] **A5: Only if A4 fails for raw-deflate fixture: add fallback**

Replace the implementation body with:

```typescript
      if (entry.compressed) {
        try { return inflateRawSync(buf); }
        catch { return unzipSync(buf); }
      }
```

Re-run A4; expected: all tests pass.

- [ ] **A6: Re-run the Pre-Flight repro script**

Run: `npx tsx scripts/repro-pak-read.ts`
Expected: all paths report `OK` with plausible byte counts.

- [ ] **A7: Commit**

```bash
git add src/pak/vfs.ts tests/pak/vfs.test.ts
git commit -m "fix(pak): support zlib-wrapped deflate in pak entries

Real Enfusion workshop paks (RHS, RealisticCombatDrones, etc.) compress
entries with zlib-wrapped deflate. The reader called inflateRawSync and
failed with 'invalid stored block lengths' / 'invalid block type' on the
wrapper header bytes. Switch to unzipSync (with a raw-deflate fallback
for older or synthetic paks).

Fixes #11"
```

### Branch B — Per-entry header bytes

**Files:**
- Modify: `src/pak/reader.ts` (entry parsing, to capture the new field) and `src/pak/vfs.ts:138-155`
- Test: `tests/pak/vfs.test.ts`, `tests/pak/reader.test.ts`

- [ ] **B1: Document the header layout**

In `src/pak/reader.ts`, above the file-entry block in `parseEntry`, add a comment describing the per-entry header discovered in Phase 1 (offset from start of entry data, byte count, interpretation — e.g. "4-byte CRC32 before the deflate stream").

- [ ] **B2: Write a failing test that models the per-entry header**

In `tests/pak/vfs.test.ts`, extend the fixture builder to prepend N junk bytes (matching the Phase 1 finding) in front of compressed payloads, then assert `readFile` still decodes. Insert after the existing "reads compressed file" test. Use the exact N from Phase 1.

- [ ] **B3: Run the test to verify it fails**

Run: `npx vitest run tests/pak/vfs.test.ts -t "per-entry header"`
Expected: FAIL with zlib error.

- [ ] **B4: Implement the minimal fix in `readFile`**

Edit `src/pak/vfs.ts:138-155`. After reading `buf`, slice off the first N bytes before decompressing. Exact N and rationale come from Phase 1. Show the code inline in this step before committing — do not leave a placeholder.

Specifically, if N = 4 (example):

```typescript
      if (entry.compressed) {
        return inflateRawSync(buf.subarray(4));
      }
```

- [ ] **B5: Run all pak tests**

Run: `npx vitest run tests/pak`
Expected: PASS (including existing synthetic-pak tests — if they break, the fixture builder must prepend the same N bytes to match reality; update the builder).

- [ ] **B6: Re-run the Pre-Flight repro script**

Same as A6.

- [ ] **B7: Commit**

```bash
git add src/pak/reader.ts src/pak/vfs.ts tests/pak/vfs.test.ts
git commit -m "fix(pak): skip per-entry <N>-byte header before decompressing

Real Enfusion paks prefix each compressed entry with an <N>-byte header
(<interpretation from Phase 1>) before the deflate stream. The reader
was handing these bytes to inflateRaw, which failed with zlib errors.

Fixes #11"
```

### Branch C — Different compression algorithm

**Files:**
- Modify: `package.json` (add dep), `src/pak/vfs.ts`
- Test: `tests/pak/vfs.test.ts`

- [ ] **C1: Add the decoder dependency**

Based on Phase 1 finding:
- LZ4 frame (`04 22 4D 18`): `npm install lz4-napi`
- LZ4 legacy (`02 21`): `npm install lz4` (with `--legacy-peer-deps` if required)
- zstd (`28 B5 2F FD`): `npm install @mongodb-js/zstd`

Run the exact command from the Phase 1 finding. Commit `package.json` and `package-lock.json` separately before touching source, so the dep change has its own reviewable commit.

- [ ] **C2: Write a failing test that uses the real compression format**

Use the decoder lib's encode function in the test fixture builder. Exact code depends on the chosen library — write the test inline once the dep is installed; do not leave as placeholder.

- [ ] **C3: Run the test**

Run: `npx vitest run tests/pak/vfs.test.ts -t "<new algorithm>"`
Expected: FAIL.

- [ ] **C4: Implement the decoder in `readFile`**

Replace the single `inflateRawSync` call with a format dispatch. Example shape (LZ4):

```typescript
import { uncompressSync as lz4Uncompress } from "lz4-napi";
// ...
      if (entry.compressed) {
        return Buffer.from(lz4Uncompress(buf));
      }
```

Concrete code depends on the library chosen. If the format differs per-entry (some zlib, some LZ4), detect by magic bytes before dispatching. Phase 1 should have already established whether mixing occurs.

- [ ] **C5: Run all pak tests**

Run: `npx vitest run tests/pak`
Expected: PASS.

- [ ] **C6: Re-run Pre-Flight repro script**

Same as A6.

- [ ] **C7: Commit**

```bash
git add package.json package-lock.json src/pak/vfs.ts tests/pak/vfs.test.ts
git commit -m "fix(pak): decode <algorithm> compressed pak entries

Real Enfusion paks compress entries with <algorithm>, not raw deflate.
Added <library> as a dependency and switched the compressed-entry
branch in readFile to use it.

Fixes #11"
```

---

## Phase 3: Regression Fixture and Cleanup

**Files:**
- Create: `tests/fixtures/pak/real-entry.bin` (small binary fixture)
- Modify: `tests/pak/vfs.test.ts`
- Delete: `scripts/repro-pak-read.ts`, `scripts/diagnose-pak-entry.ts`

### Task 3.1: Capture a real failing entry as a fixture

- [ ] **Step 1: Extract the raw bytes of one real entry**

Run a one-liner to dump bytes from a real pak into the fixtures dir:

```bash
mkdir -p tests/fixtures/pak
npx tsx -e "
import { openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { parsePakIndex } from './src/pak/reader.js';
const PAK = '/mnt/c/Users/wicae/Documents/My Games/ArmaReforger/addons/RealisticCombatDrones_65AD60E204191D37/data.pak';
const idx = parsePakIndex(PAK);
// Walk to scripts/Game/Drone/DroneComponents/SAL_DroneSignalComponent.c
const parts = 'scripts/Game/Drone/DroneComponents/SAL_DroneSignalComponent.c'.split('/');
let cur: any = idx.root;
for (const p of parts) cur = cur.children.get(p);
const fd = openSync(PAK, 'r');
const buf = Buffer.alloc(cur.compressedLen);
readSync(fd, buf, 0, cur.compressedLen, idx.dataStart + cur.offset);
closeSync(fd);
writeFileSync('tests/fixtures/pak/real-entry.bin', buf);
writeFileSync('tests/fixtures/pak/real-entry.meta.json', JSON.stringify({
  compressedLen: cur.compressedLen, decompressedLen: cur.decompressedLen, compressed: cur.compressed,
}, null, 2));
console.log('wrote', buf.length, 'bytes');
"
```
Expected: `tests/fixtures/pak/real-entry.bin` exists, size equals `compressedLen` from Phase 1 diagnostic.

Note: if licensing of the extracted bytes is a concern, use the smallest possible failing entry (a tiny `.c` file) and document its provenance in a `tests/fixtures/pak/README.md` one-liner.

- [ ] **Step 2: Write a test that loads the fixture and decompresses it**

Add to `tests/pak/vfs.test.ts`:

```typescript
it("decompresses a fixture captured from a real workshop pak", () => {
  const bin = readFileSync("tests/fixtures/pak/real-entry.bin");
  const meta = JSON.parse(readFileSync("tests/fixtures/pak/real-entry.meta.json", "utf-8"));
  // Call the same decompression path readFile uses, on the raw bytes.
  // If readFile is not directly usable, export a small decompressEntry helper
  // from vfs.ts and use it here. Do NOT inline a second copy of the logic.
  const out = decompressEntry(bin, meta.compressed);
  expect(out.length).toBe(meta.decompressedLen);
});
```

If no `decompressEntry` helper exists, extract one from `readFile` (lines 152-154) in a refactor commit before this test lands. Keep the helper exported but underscored (`_decompressEntry`) to mark it as test-only.

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/pak/vfs.test.ts -t "fixture captured from a real"`
Expected: PASS.

- [ ] **Step 4: Delete the one-shot scripts**

```bash
rm scripts/repro-pak-read.ts scripts/diagnose-pak-entry.ts
rmdir scripts 2>/dev/null || true
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/pak tests/pak/vfs.test.ts src/pak/vfs.ts
git rm scripts/repro-pak-read.ts scripts/diagnose-pak-entry.ts 2>/dev/null || true
git commit -m "test(pak): regression fixture from a real workshop pak entry

Captures a single compressed entry from a real Enfusion pak as a binary
fixture, plus a test that runs it through the decompression path. This
would have caught issue #11 before it shipped."
```

---

## Phase 4: Close the Issue

- [ ] **Step 1: Push the branch**

```bash
git push -u origin fix/pak-decompression
```

- [ ] **Step 2: Open PR referencing the issue**

```bash
gh pr create --title "fix(pak): decompress real Enfusion workshop paks" --body "$(cat <<'EOF'
## Summary
- Phase 1 diagnostic identified the real pak format as <branch A/B/C — fill in>.
- Phase 2 implementation updates the decompression path accordingly.
- Phase 3 adds a regression fixture derived from a real workshop pak.

Fixes #11

## Test plan
- [x] Unit tests for the new decompression path pass
- [x] Fixture-based regression test passes
- [x] Full suite (`npm test`) passes
- [x] Manual repro of issue #11 (via `scripts/repro-pak-read.ts` before deletion) now reports OK for all previously-failing paths
EOF
)"
```

- [ ] **Step 3: Update the issue**

Comment on issue #11 linking the PR and noting whether the root cause matched any of the three hypotheses originally proposed (zlib-wrapped, per-entry prefix, or alternate algorithm).

---

## Self-Review (completed before handoff)

- **Spec coverage:** The spec (issue #11) reports zlib errors on `game_read` for paks at a specific path. Pre-Flight reproduces; Phase 1 diagnoses; Phase 2 fixes along the correct branch; Phase 3 adds regression coverage; Phase 4 closes the loop. ✅
- **Placeholder scan:** Phase 1 is genuinely diagnostic (the script runs real code, not a hand-wave), and Phase 2 is gated on its output. Within each of the three branches A/B/C, all code is concrete. The only genuine unknowns (N bytes for Branch B, exact library for Branch C) are parameters that Phase 1 produces — the plan says "use the exact N from Phase 1" rather than leaving a TBD. ✅
- **Type consistency:** `PakVirtualFS`, `parsePakIndex`, `readFile`, `readTextFile`, `buildFixturePak`, `openVfsFromBuffer` — all reference real exports in the current repo. `decompressEntry` is introduced in Phase 3.2 as a refactor. ✅

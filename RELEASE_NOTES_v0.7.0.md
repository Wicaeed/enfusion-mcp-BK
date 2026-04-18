# v0.7.0 — Third-Party Mod Research (Workshop Pak Discovery)

Enhancement to the existing Research functionality (`game_browse`, `game_read`, `asset_search`): the tool now merges workshop mod paks alongside the base game, so research queries can reach into RHS, Realistic Combat Drones, Salami, and any other installed Reforger addon — not just the base game.

## Features

### Workshop mod discovery

`PakVirtualFS` now merges multiple pak roots into a single unified tree. On startup, `enfusion-mcp` probes the two standard workshop cache locations and uses whichever exist:

- `~/Documents/My Games/ArmaReforger/addons` — game client's workshop cache
- `~/Documents/My Games/ArmaReforgerWorkbench/addons` — Workbench workshop cache

Base game paks take precedence on any path collisions, so vanilla files are never shadowed by mod overrides.

**Scale:** in a typical setup the indexed file count jumps from ~84k (base game only) to ~396k (base game + installed workshop mods).

### Explicit override

Autodiscovery is bypassed when either is set:

- Env var `REFORGER_MOD_PATHS` — comma- or semicolon-separated list of addon roots.
- JSON config `modPaths: string[]` in `enfusion-mcp.config.json`.

The resolved list is logged at startup.

## Bug Fixes

### PAK reader — real workshop paks now decompress

Two bugs in `PakVirtualFS.readFile` prevented reading any compressed entry from real workshop paks (RHS, RCD, Salami, etc.). Synthetic test fixtures had coincidentally round-tripped with the wrong behavior, so unit tests passed while real paks failed.

- **Absolute offsets.** `entry.offset` is an absolute `.pak` byte position, not relative to the DATA chunk. The reader was adding `dataStart` on top, landing `dataStart` bytes past every real entry.
- **Zlib-wrapped deflate.** Compressed entries use zlib-wrapped deflate (`0x78 0x9c` header), not raw deflate. `inflateRawSync` was replaced with `inflateSync`.

Both verified against [PakInspector](https://github.com/hanakocz/PakInspector)'s reference kaitai parser and extract path. A regression test now locks in the zlib-header + absolute-offset format invariants.

## Breaking Changes

### `ENFUSION_MOD_PATHS` → `REFORGER_MOD_PATHS`

The env var introduced in the workshop-discovery work has been renamed. The underlying feature is Reforger-specific research tooling (workshop mod discovery), not an Enfusion engine feature, and the prefix now reflects that. Other engine-level env vars (`ENFUSION_WORKBENCH_PATH`, `ENFUSION_GAME_PATH`, etc.) are unchanged.

**Migration:** rename any `ENFUSION_MOD_PATHS` in your MCP client config (`.claude.json`, `claude_desktop_config.json`) to `REFORGER_MOD_PATHS`. The `modPaths` JSON config key is unchanged.

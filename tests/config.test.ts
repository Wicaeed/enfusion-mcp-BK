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
  "REFORGER_MOD_PATHS",
  "HOME",
  "USERPROFILE",
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

  it("REFORGER_MOD_PATHS env var overrides discovery (semicolon + comma separators)", () => {
    process.env.REFORGER_MOD_PATHS = "/a/one,/b/two;/c/three";
    const cfg = loadConfig();
    expect(cfg.modPaths).toEqual(["/a/one", "/b/two", "/c/three"]);
  });

  it("trims whitespace and ignores empty entries in REFORGER_MOD_PATHS", () => {
    process.env.REFORGER_MOD_PATHS = " /a , , /b ";
    const cfg = loadConfig();
    expect(cfg.modPaths).toEqual(["/a", "/b"]);
  });
});

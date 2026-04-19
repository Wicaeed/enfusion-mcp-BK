/**
 * Cross-platform path helpers for mixed WSL/Windows workflows.
 *
 * Arma Reforger Workbench is a Windows executable, so `.gproj` paths passed
 * through the MCP are often Windows-style (`C:\Users\…\foo.gproj`) even when
 * the MCP itself runs on Linux (WSL). Node's default `path` module follows
 * POSIX semantics on Linux, so `path.dirname("C:\\Users\\…")` returns `"."`
 * — silently losing the directory and causing handler-copy operations to
 * land in the MCP's cwd rather than the mod directory.
 *
 * These helpers detect Windows-style absolute paths and apply the correct
 * parsing/translation so file operations work regardless of host OS.
 */

import { win32, posix } from "node:path";

/** Matches Windows absolute paths: `C:\…` or `C:/…` (any drive letter). */
const WINDOWS_ABS_PATH = /^[A-Za-z]:[\\/]/;

/** True if `p` looks like a Windows absolute path (drive letter + separator). */
export function isWindowsPath(p: string): boolean {
  return WINDOWS_ABS_PATH.test(p);
}

/**
 * `dirname(p)` using whichever semantics match the path shape.
 * Falls back to the current platform's default for non-absolute paths.
 */
export function crossPlatformDirname(p: string): string {
  return isWindowsPath(p) ? win32.dirname(p) : posix.dirname(p);
}

/** `basename(p)` using whichever semantics match the path shape. */
export function crossPlatformBasename(p: string): string {
  return isWindowsPath(p) ? win32.basename(p) : posix.basename(p);
}

/**
 * Translate a Windows path to its WSL mount equivalent so Node's fs APIs
 * can reach it from Linux. On Windows hosts or for non-Windows paths,
 * returns `p` unchanged.
 *
 * Example: `C:\Users\foo\bar` → `/mnt/c/Users/foo/bar`
 */
export function toNativePath(p: string): string {
  if (!isWindowsPath(p)) return p;
  if (process.platform === "win32") return p;
  const drive = p[0].toLowerCase();
  const rest = p.slice(2).replace(/\\/g, "/");
  return `/mnt/${drive}${rest}`;
}

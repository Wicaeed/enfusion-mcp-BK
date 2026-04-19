import { describe, it, expect } from "vitest";
import {
  isWindowsPath,
  crossPlatformDirname,
  crossPlatformBasename,
  toNativePath,
} from "../../src/utils/platform-path.js";

describe("isWindowsPath", () => {
  it("recognises drive-letter paths with backslashes", () => {
    expect(isWindowsPath("C:\\Users\\wicae\\foo.gproj")).toBe(true);
    expect(isWindowsPath("D:\\addons\\mod")).toBe(true);
  });

  it("recognises drive-letter paths with forward slashes", () => {
    expect(isWindowsPath("C:/Users/wicae/foo.gproj")).toBe(true);
  });

  it("rejects POSIX absolute paths", () => {
    expect(isWindowsPath("/home/wicae/foo")).toBe(false);
    expect(isWindowsPath("/mnt/c/Users/wicae/foo")).toBe(false);
  });

  it("rejects relative paths", () => {
    expect(isWindowsPath("foo/bar")).toBe(false);
    expect(isWindowsPath("./foo")).toBe(false);
    expect(isWindowsPath("foo.gproj")).toBe(false);
  });

  it("rejects drive letter without separator", () => {
    expect(isWindowsPath("C:foo")).toBe(false);
  });
});

describe("crossPlatformDirname", () => {
  it("handles Windows paths with backslashes", () => {
    const input = "C:\\Users\\wicae\\addons\\bnh-core\\bnh-core.gproj";
    expect(crossPlatformDirname(input)).toBe("C:\\Users\\wicae\\addons\\bnh-core");
  });

  it("handles Windows paths with forward slashes", () => {
    const input = "C:/Users/wicae/addons/bnh-core/bnh-core.gproj";
    // win32.dirname preserves the forward slashes in the output
    expect(crossPlatformDirname(input)).toBe("C:/Users/wicae/addons/bnh-core");
  });

  it("does not return '.' for Windows paths on POSIX hosts (regression)", () => {
    // This is the original bug: posix.dirname(windowsPath) returned "."
    // because no `/` exists in the backslash-separated path.
    const input = "C:\\Users\\wicae\\addons\\bnh-core\\bnh-core.gproj";
    expect(crossPlatformDirname(input)).not.toBe(".");
  });

  it("handles POSIX paths correctly", () => {
    expect(crossPlatformDirname("/home/wicae/foo/bar.gproj")).toBe("/home/wicae/foo");
  });
});

describe("crossPlatformBasename", () => {
  it("handles Windows paths", () => {
    const input = "C:\\Users\\wicae\\addons\\bnh-core\\bnh-core.gproj";
    expect(crossPlatformBasename(input)).toBe("bnh-core.gproj");
  });

  it("handles POSIX paths", () => {
    expect(crossPlatformBasename("/home/wicae/foo/bar.gproj")).toBe("bar.gproj");
  });
});

describe("toNativePath", () => {
  it("translates Windows paths to /mnt/<drive>/... on non-Windows hosts", () => {
    // Test assumes we're running on Linux (WSL), where these tests normally execute.
    if (process.platform === "win32") return;
    expect(toNativePath("C:\\Users\\wicae\\foo")).toBe("/mnt/c/Users/wicae/foo");
    expect(toNativePath("D:\\addons\\mod\\bar.gproj")).toBe("/mnt/d/addons/mod/bar.gproj");
  });

  it("lowercases the drive letter", () => {
    if (process.platform === "win32") return;
    expect(toNativePath("C:\\foo")).toBe("/mnt/c/foo");
  });

  it("preserves forward-slash Windows paths", () => {
    if (process.platform === "win32") return;
    expect(toNativePath("C:/Users/wicae/foo")).toBe("/mnt/c/Users/wicae/foo");
  });

  it("returns POSIX paths unchanged", () => {
    expect(toNativePath("/home/wicae/foo")).toBe("/home/wicae/foo");
    expect(toNativePath("/mnt/c/Users/wicae/foo")).toBe("/mnt/c/Users/wicae/foo");
  });

  it("returns relative paths unchanged", () => {
    expect(toNativePath("foo/bar")).toBe("foo/bar");
    expect(toNativePath("./bar.gproj")).toBe("./bar.gproj");
  });
});

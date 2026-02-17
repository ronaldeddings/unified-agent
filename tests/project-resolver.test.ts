import { describe, expect, test } from "bun:test";
import { encodeProjectPath } from "../src/scanner/projectResolver";

describe("project resolver", () => {
  test("10.20: encodeProjectPath replaces /, ., _ with -", () => {
    const result = encodeProjectPath("/Volumes/VRAM/10-19_Work/10_Hacker_Valley_Media/10.09_technology");
    expect(result).toBe("-Volumes-VRAM-10-19-Work-10-Hacker-Valley-Media-10-09-technology");
  });

  test("10.20: encodeProjectPath handles simple paths", () => {
    const result = encodeProjectPath("/Users/test/my_project");
    expect(result).toBe("-Users-test-my-project");
  });

  test("10.20: encodeProjectPath strips trailing slashes", () => {
    const result = encodeProjectPath("/Users/test/project/");
    expect(result).toBe("-Users-test-project");
  });

  test("10.20: encodeProjectPath handles paths with dots", () => {
    const result = encodeProjectPath("/home/user/.config/project.name");
    expect(result).toBe("-home-user--config-project-name");
  });

  test("10.20: encodeProjectPath handles nested underscores and dots", () => {
    const result = encodeProjectPath("/Volumes/VRAM/00-09_System/01_Tools/unified-agent");
    expect(result).toBe("-Volumes-VRAM-00-09-System-01-Tools-unified-agent");
  });
});

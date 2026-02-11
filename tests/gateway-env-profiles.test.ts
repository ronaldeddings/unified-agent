import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvProfileStore } from "../src/gateway/envProfiles";

describe("env profiles", () => {
  test("put/get/delete profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-env-profile-"));
    const store = new EnvProfileStore(join(dir, "env-profiles.json"));

    store.put("dev", { A: "1", B: "2" });
    expect(store.get("dev")).toEqual({ A: "1", B: "2" });
    expect(Object.keys(store.list())).toContain("dev");
    expect(store.delete("dev")).toBe(true);
    expect(store.get("dev")).toBeUndefined();
  });
});

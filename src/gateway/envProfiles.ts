import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getDataDir } from "../util/paths";

interface EnvProfileState {
  version: 1;
  profiles: Record<string, Record<string, string>>;
}

export class EnvProfileStore {
  private readonly path: string;

  constructor(path = `${getDataDir()}/env-profiles.json`) {
    this.path = path;
  }

  list(): Record<string, Record<string, string>> {
    const state = this.read();
    return state.profiles;
  }

  get(name: string): Record<string, string> | undefined {
    const state = this.read();
    return state.profiles[name];
  }

  put(name: string, variables: Record<string, string>): void {
    const state = this.read();
    state.profiles[name] = { ...variables };
    this.write(state);
  }

  delete(name: string): boolean {
    const state = this.read();
    if (!state.profiles[name]) return false;
    delete state.profiles[name];
    this.write(state);
    return true;
  }

  private read(): EnvProfileState {
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as EnvProfileState;
      if (parsed && parsed.version === 1 && parsed.profiles && typeof parsed.profiles === "object") {
        return parsed;
      }
    } catch {
      // ignore
    }
    return { version: 1, profiles: {} };
  }

  private write(state: EnvProfileState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, this.path);
  }
}

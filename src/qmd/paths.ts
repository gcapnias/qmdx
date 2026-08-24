import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

const QMD_DIR = ".qmd";
const CONFIG_NAMES = ["index.yaml", "index.yml"] as const;

export interface ProjectIndexLocation {
  root: string;
  configPath: string;
  dbPath: string;
}

export function findProjectIndex(startDir?: string): ProjectIndexLocation | null {
  let current = resolve(startDir ?? process.cwd());
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const configPath = join(current, QMD_DIR, name);
      if (!existsSync(configPath)) continue;
      return {
        root: current,
        configPath,
        dbPath: join(current, QMD_DIR, "index.sqlite"),
      };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

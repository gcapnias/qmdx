import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "config.json";
export const CONFIG_DIR_NAME = "qmdx";

/**
 * OS-standard QMDX user configuration directory. `QMDX_CONFIG_DIR` overrides
 * the location as a test/automation seam; normal users always get the
 * platform-standard directory.
 */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.QMDX_CONFIG_DIR;
  if (override !== undefined && override.trim() !== "") return override;
  switch (process.platform) {
    case "win32":
      return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), CONFIG_DIR_NAME);
    case "darwin":
      return join(homedir(), "Library", "Application Support", CONFIG_DIR_NAME);
    default:
      return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), CONFIG_DIR_NAME);
  }
}

export function userConfigFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(userConfigDir(env), CONFIG_FILE_NAME);
}

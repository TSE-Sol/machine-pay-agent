// Reads the few values scripts need from tunnel/config.yml (the named tunnel's config).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const tunnelConfigPath = fileURLToPath(new URL("../tunnel/config.yml", import.meta.url));

/** Pull tunnel id, hostname and local service out of the config text. Missing values are null. */
export function parseTunnelConfig(text) {
  const withoutComments = text.replace(/^\s*#.*$/gm, "");
  const find = (pattern) => withoutComments.match(pattern)?.[1]?.trim() ?? null;
  const service = find(/^\s*service:\s*(https?:\/\/\S+)/m);
  return {
    tunnelId: find(/^tunnel:\s*(\S+)/m),
    hostname: find(/^\s*-?\s*hostname:\s*(\S+)/m),
    service,
    servicePort: service ? Number(new URL(service).port || (service.startsWith("https") ? 443 : 80)) : null,
  };
}

/** The named tunnel's settings, plus where its credentials file should be. Null if there is no config. */
export function loadTunnelConfig(path = tunnelConfigPath) {
  if (!existsSync(path)) return null;
  const config = parseTunnelConfig(readFileSync(path, "utf8"));
  return {
    ...config,
    path,
    // Created by `cloudflared tunnel create`; never committed.
    credentialsFile: config.tunnelId ? join(homedir(), ".cloudflared", `${config.tunnelId}.json`) : null,
  };
}

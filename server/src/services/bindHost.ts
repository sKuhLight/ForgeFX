// The address the HTTP server listens on (FORGEFX-51).
//
// Inside the Axis desktop app (Electron runs this server in its main process) nothing but the app itself
// talks to the server: the renderer loads http://localhost:<port> and the main process fetches the same
// origin, and the app picks its port by probing 127.0.0.1. So the desktop build listens on loopback only
// and is not reachable from the LAN. Everywhere else (Docker/GHCR, a headless Raspberry Pi, `npm run dev`)
// LAN access is the point, so the default stays 0.0.0.0. FORGEFX_HOST overrides both (e.g. `127.0.0.1` for
// a headless box behind a local reverse proxy, `::` for IPv6).
//
// Pure: the environment and the runtime versions are parameters (defaults: this process).

export const LOOPBACK_BIND = '127.0.0.1';
export const ALL_INTERFACES_BIND = '0.0.0.0';

export function selectBindHost(
  env: Record<string, string | undefined> = process.env,
  versions: Record<string, string | undefined> = process.versions
): string {
  const override = env.FORGEFX_HOST?.trim();
  if (override) return override;
  return versions.electron ? LOOPBACK_BIND : ALL_INTERFACES_BIND;
}

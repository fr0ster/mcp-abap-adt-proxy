/**
 * Platform-specific stores for proxy
 * Uses XsuaaServiceKeyStore and either XsuaaSessionStore or SafeXsuaaSessionStore
 * depending on the unsafe configuration parameter
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type {
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/auth-broker';
import {
  SafeXsuaaSessionStore,
  XsuaaServiceKeyStore,
  XsuaaSessionStore,
} from '@mcp-abap-adt/auth-stores';

/**
 * Get platform-specific default paths for service keys and sessions
 *
 * Priority (matching mcp-abap-adt logic):
 * 1. AUTH_BROKER_PATH environment variable
 * 2. Platform-specific standard paths (only if no env paths were found):
 *    - Unix: ~/.config/mcp-abap-adt/{subfolder}
 *    - Windows: %USERPROFILE%\Documents\mcp-abap-adt\{subfolder}
 * 3. Current working directory (process.cwd())
 *
 * @param subfolder One of the four folders; see {@link StoreFolder}
 * @returns Array of resolved absolute paths
 */
/**
 * The four folders the toolchain keeps under one base.
 *
 * `service-keys/` and `sessions/` are the auth broker's. `proxy/` holds one
 * ready config per proxy — the files `--config` takes. `runtime/` holds a
 * record per live proxy, so one session can see another's.
 */
export type StoreFolder = 'service-keys' | 'sessions' | 'proxy' | 'runtime';

/**
 * THE base directory — one answer, not a search path.
 *
 * `AUTH_BROKER_PATH` relocates it, so all four folders move together; when it
 * lists several, the first is the one written to. Unlike
 * {@link getPlatformPaths}, this never falls back to the working directory: a
 * file written beside wherever a client happened to be launched from is a file
 * the next session will not find.
 */
export function storeBaseDir(): string {
  const envPath = process.env.AUTH_BROKER_PATH;
  if (envPath) {
    const first = envPath
      .split(/[:;]/)
      .map((p) => p.trim())
      .find((p) => p.length > 0);
    if (first) return path.resolve(first);
  }

  const homeDir = os.homedir();
  return process.platform === 'win32'
    ? path.join(homeDir, 'Documents', 'mcp-abap-adt')
    : path.join(homeDir, '.config', 'mcp-abap-adt');
}

/** THE directory for one of the four folders. */
export function storeDir(folder: StoreFolder): string {
  return path.join(storeBaseDir(), folder);
}

export function getPlatformPaths(subfolder?: StoreFolder): string[] {
  const paths: string[] = [];
  const isWindows = process.platform === 'win32';

  // Priority 1: AUTH_BROKER_PATH environment variable
  // AUTH_BROKER_PATH is treated as a base path; append subfolder when requested
  const envPath = process.env.AUTH_BROKER_PATH;
  if (envPath) {
    // Support both colon (Unix) and semicolon (Windows) separators
    const envPaths = envPath
      .split(/[:;]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    paths.push(
      ...envPaths.map((p) => {
        let resolved = path.resolve(p);
        // If path already ends with subfolder, use parent as base path
        if (subfolder && path.basename(resolved) === subfolder) {
          resolved = path.dirname(resolved);
        }
        return subfolder ? path.join(resolved, subfolder) : resolved;
      }),
    );
  }

  // Priority 2: Platform-specific standard paths
  // Only add platform-specific paths if no custom paths were provided (matching mcp-abap-adt logic)
  if (paths.length === 0) {
    const homeDir = os.homedir();

    if (isWindows) {
      // Windows: %USERPROFILE%\Documents\mcp-abap-adt\{subfolder}
      const basePath = path.join(homeDir, 'Documents', 'mcp-abap-adt');
      if (subfolder) {
        paths.push(path.join(basePath, subfolder));
      } else {
        paths.push(basePath);
      }
    } else {
      // Unix (Linux/macOS): ~/.config/mcp-abap-adt/{subfolder}
      const basePath = path.join(homeDir, '.config', 'mcp-abap-adt');
      if (subfolder) {
        paths.push(path.join(basePath, subfolder));
      } else {
        paths.push(basePath);
      }
    }
  }

  // Priority 3: Current working directory (always added as fallback)
  paths.push(process.cwd());

  // Remove duplicates while preserving order
  const uniquePaths: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const normalized = path.normalize(p);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniquePaths.push(normalized);
    }
  }

  return uniquePaths;
}

/**
 * Get platform-specific stores
 * Returns XSUAA stores for BTP authentication:
 * - If unsafe=true: uses XsuaaSessionStore (persists to disk)
 * - If unsafe=false: uses SafeXsuaaSessionStore (in-memory, secure)
 * - Service key store: XsuaaServiceKeyStore
 * @param unsafe If true, use XsuaaSessionStore. If false, use SafeXsuaaSessionStore (default).
 */
export async function getPlatformStores(unsafe: boolean = false): Promise<{
  serviceKeyStore: IServiceKeyStore;
  sessionStore: ISessionStore;
}> {
  // Get platform-specific paths for service keys and sessions
  const serviceKeyPaths = getPlatformPaths('service-keys');
  const sessionPaths = getPlatformPaths('sessions');

  // Stores only support a single directory, use the first path
  const firstServiceKeyPath = serviceKeyPaths[0] || process.cwd();
  const firstSessionPath = sessionPaths[0] || process.cwd();

  const serviceKeyStore = new XsuaaServiceKeyStore(firstServiceKeyPath);

  // Note: XSUAA stores require defaultServiceUrl (cannot be obtained from service key)
  // For now, we use empty string as placeholder - it will be set when session is created
  const sessionStore = unsafe
    ? new XsuaaSessionStore(firstSessionPath, '')
    : new SafeXsuaaSessionStore('');

  return {
    serviceKeyStore,
    sessionStore,
  };
}

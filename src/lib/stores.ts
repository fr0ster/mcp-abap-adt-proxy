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
 * @param subfolder Subfolder name ('service-keys' or 'sessions')
 * @returns Array of resolved absolute paths
 */
function getPlatformPaths(subfolder?: 'service-keys' | 'sessions'): string[] {
  const paths: string[] = [];
  const isWindows = process.platform === 'win32';

  // Priority 1: AUTH_BROKER_PATH environment variable
  const envPath = process.env.AUTH_BROKER_PATH;
  if (envPath) {
    // Support both colon (Unix) and semicolon (Windows) separators
    const envPaths = envPath
      .split(/[:;]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    paths.push(...envPaths.map((p) => path.resolve(p)));
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

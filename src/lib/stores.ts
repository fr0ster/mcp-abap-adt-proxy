/**
 * Platform-specific stores for proxy
 * Uses AbapServiceKeyStore/XsuaaServiceKeyStore and either AbapSessionStore or SafeAbapSessionStore
 * depending on the unsafe configuration parameter
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type {
  IServiceKeyStore,
  ISessionStore,
} from '@mcp-abap-adt/auth-broker';
import {
  AbapServiceKeyStore,
  AbapSessionStore,
  SafeAbapSessionStore,
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

// No CombinedServiceKeyStore needed - we use separate stores for BTP and ABAP

/**
 * Get platform-specific stores
 * Returns stores based on configuration:
 * - If unsafe=true: uses AbapSessionStore (persists to disk)
 * - If unsafe=false: uses SafeAbapSessionStore (in-memory, secure)
 * - Service key store: Separate stores - XSUAA store for BTP, ABAP store for ABAP
 * @param unsafe If true, use AbapSessionStore. If false, use SafeAbapSessionStore (default).
 * @param useXsuaaStore If true, use XsuaaServiceKeyStore (for BTP destinations). If false, use AbapServiceKeyStore (for ABAP destinations).
 */
export async function getPlatformStores(
  unsafe: boolean = false,
  useXsuaaStore: boolean = false,
): Promise<{
  serviceKeyStore: IServiceKeyStore;
  sessionStore: ISessionStore;
}> {
  // Get platform-specific paths for service keys and sessions
  const serviceKeyPaths = getPlatformPaths('service-keys');
  const sessionPaths = getPlatformPaths('sessions');

  // Stores only support a single directory, use the first path
  const firstServiceKeyPath = serviceKeyPaths[0] || process.cwd();
  const firstSessionPath = sessionPaths[0] || process.cwd();

  // Use separate stores: XSUAA store for BTP, ABAP store for ABAP
  const serviceKeyStore = useXsuaaStore
    ? new XsuaaServiceKeyStore(firstServiceKeyPath)
    : new AbapServiceKeyStore(firstServiceKeyPath);

  // Use appropriate session store based on store type
  // For XSUAA destinations: use SafeXsuaaSessionStore or XsuaaSessionStore
  // For ABAP destinations: use SafeAbapSessionStore or AbapSessionStore
  // Note: XSUAA stores require defaultServiceUrl (cannot be obtained from service key)
  // For now, we use empty string as placeholder - it will be set when session is created
  const sessionStore = unsafe
    ? useXsuaaStore
      ? new XsuaaSessionStore(firstSessionPath, '')
      : new AbapSessionStore(firstSessionPath)
    : useXsuaaStore
      ? new SafeXsuaaSessionStore('')
      : new SafeAbapSessionStore();

  return {
    serviceKeyStore,
    sessionStore,
  };
}

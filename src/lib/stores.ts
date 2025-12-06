/**
 * Platform-specific stores for proxy
 * Uses AbapServiceKeyStore/XsuaaServiceKeyStore and either AbapSessionStore or SafeAbapSessionStore
 * depending on the unsafe configuration parameter
 */

import { 
  AbapServiceKeyStore,
  XsuaaServiceKeyStore,
  AbapSessionStore, 
  SafeAbapSessionStore
} from "@mcp-abap-adt/auth-stores";
import type { 
  IServiceKeyStore,
  ISessionStore,
  IAuthorizationConfig,
  IConnectionConfig,
  IConfig
} from "@mcp-abap-adt/auth-broker";
import * as path from "path";
import * as os from "os";

/**
 * Get platform-specific default paths for service keys and sessions
 * 
 * Priority:
 * 1. AUTH_BROKER_PATH environment variable
 * 2. Platform-specific standard paths:
 *    - Unix: ~/.config/mcp-abap-adt/service-keys
 *    - Windows: %USERPROFILE%\Documents\mcp-abap-adt\service-keys
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
    const envPaths = envPath.split(/[:;]/).map(p => p.trim()).filter(p => p.length > 0);
    paths.push(...envPaths.map(p => path.resolve(p)));
  }

  // Priority 2: Platform-specific standard paths (always added, unless AUTH_BROKER_PATH is set)
  // If AUTH_BROKER_PATH is set, platform paths are still added but with lower priority
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
 * Combined service key store that tries both standard and XSUAA loaders
 * Tries standard ABAP service key loader first, then XSUAA loader if not found
 * 
 * Note: Stores only support a single directory, so we use the first path from the array
 */
class CombinedServiceKeyStore implements IServiceKeyStore {
  private abapStore: AbapServiceKeyStore;
  private xsuaaStore: XsuaaServiceKeyStore;

  constructor(searchPaths: string[]) {
    // Stores only support a single directory, use the first path
    const firstPath = searchPaths[0] || process.cwd();
    this.abapStore = new AbapServiceKeyStore(firstPath);
    this.xsuaaStore = new XsuaaServiceKeyStore(firstPath);
  }

  async getServiceKey(destination: string): Promise<IConfig | null> {
    // Try ABAP service key store first
    const abapKey = await this.abapStore.getServiceKey(destination);
    if (abapKey) {
      return abapKey;
    }

    // If not found, try XSUAA store (for BTP XSUAA service keys)
    return await this.xsuaaStore.getServiceKey(destination);
  }

  async getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null> {
    // Try ABAP service key store first
    const abapConfig = await this.abapStore.getAuthorizationConfig(destination);
    if (abapConfig) {
      return abapConfig;
    }

    // If not found, try XSUAA store (for BTP XSUAA service keys)
    return await this.xsuaaStore.getAuthorizationConfig(destination);
  }

  async getConnectionConfig(destination: string): Promise<IConnectionConfig | null> {
    // Try ABAP service key store first
    const abapConfig = await this.abapStore.getConnectionConfig(destination);
    if (abapConfig) {
      return abapConfig;
    }

    // If not found, try XSUAA store (for BTP XSUAA service keys)
    return await this.xsuaaStore.getConnectionConfig(destination);
  }
}

/**
 * Get platform-specific stores
 * Returns stores based on configuration:
 * - If unsafe=true: uses AbapSessionStore (persists to disk)
 * - If unsafe=false: uses SafeAbapSessionStore (in-memory, secure)
 * - Service key store: Combined store that tries both standard and XSUAA loaders
 * @param unsafe If true, use AbapSessionStore. If false, use SafeAbapSessionStore (default).
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
  
  return {
    serviceKeyStore: new CombinedServiceKeyStore(serviceKeyPaths),
    sessionStore: unsafe 
      ? new AbapSessionStore(firstSessionPath)
      : new SafeAbapSessionStore(),
  };
}


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
    const envPaths = envPath.split(/[:;]/).map(p => p.trim()).filter(p => p.length > 0);
    paths.push(...envPaths.map(p => path.resolve(p)));
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
 * Combined service key store that tries both standard and XSUAA loaders
 * For BTP destinations: tries XSUAA loader first, then ABAP loader
 * For ABAP destinations: tries ABAP loader first, then XSUAA loader
 * 
 * Note: Stores only support a single directory, so we use the first path from the array
 */
class CombinedServiceKeyStore implements IServiceKeyStore {
  private abapStore: AbapServiceKeyStore;
  private xsuaaStore: XsuaaServiceKeyStore;
  private preferXsuaa: boolean;

  constructor(searchPaths: string[], preferXsuaa: boolean = false) {
    // Stores only support a single directory, use the first path
    const firstPath = searchPaths[0] || process.cwd();
    this.abapStore = new AbapServiceKeyStore(firstPath);
    this.xsuaaStore = new XsuaaServiceKeyStore(firstPath);
    this.preferXsuaa = preferXsuaa;
  }

  async getServiceKey(destination: string): Promise<IConfig | null> {
    if (this.preferXsuaa) {
      // For BTP destinations: try XSUAA first
      const xsuaaKey = await this.xsuaaStore.getServiceKey(destination);
      if (xsuaaKey) {
        return xsuaaKey;
      }
      // If XSUAA store didn't find it, don't try ABAP store (it will fail on XSUAA format)
      return null;
    } else {
      // For ABAP destinations: try ABAP first
      const abapKey = await this.abapStore.getServiceKey(destination);
      if (abapKey) {
        return abapKey;
      }
      // If not found, try XSUAA store
      return await this.xsuaaStore.getServiceKey(destination);
    }
  }

  async getAuthorizationConfig(destination: string): Promise<IAuthorizationConfig | null> {
    if (this.preferXsuaa) {
      // For BTP destinations: try XSUAA first
      const xsuaaConfig = await this.xsuaaStore.getAuthorizationConfig(destination);
      if (xsuaaConfig) {
        return xsuaaConfig;
      }
      // If XSUAA store didn't find it, don't try ABAP store (it will fail on XSUAA format)
      // Only try ABAP store if XSUAA store explicitly returned null (file not found)
      // But if file exists but is in wrong format, XSUAA store returns null, so we should not try ABAP
      return null;
    } else {
      // For ABAP destinations: try ABAP first
      const abapConfig = await this.abapStore.getAuthorizationConfig(destination);
      if (abapConfig) {
        return abapConfig;
      }
      // If not found, try XSUAA store
      return await this.xsuaaStore.getAuthorizationConfig(destination);
    }
  }

  async getConnectionConfig(destination: string): Promise<IConnectionConfig | null> {
    if (this.preferXsuaa) {
      // For BTP destinations: try XSUAA first
      const xsuaaConfig = await this.xsuaaStore.getConnectionConfig(destination);
      if (xsuaaConfig) {
        return xsuaaConfig;
      }
      // If XSUAA store didn't find it, don't try ABAP store (it will fail on XSUAA format)
      return null;
    } else {
      // For ABAP destinations: try ABAP first
      const abapConfig = await this.abapStore.getConnectionConfig(destination);
      if (abapConfig) {
        return abapConfig;
      }
      // If not found, try XSUAA store
      return await this.xsuaaStore.getConnectionConfig(destination);
    }
  }
}

/**
 * Get platform-specific stores
 * Returns stores based on configuration:
 * - If unsafe=true: uses AbapSessionStore (persists to disk)
 * - If unsafe=false: uses SafeAbapSessionStore (in-memory, secure)
 * - Service key store: Combined store that tries both standard and XSUAA loaders
 * @param unsafe If true, use AbapSessionStore. If false, use SafeAbapSessionStore (default).
 * @param preferXsuaa If true, prefer XSUAA store for BTP destinations. If false, prefer ABAP store (default).
 */
export async function getPlatformStores(
  unsafe: boolean = false,
  preferXsuaa: boolean = false
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
  
  return {
    serviceKeyStore: new CombinedServiceKeyStore(serviceKeyPaths, preferXsuaa),
    sessionStore: unsafe 
      ? new AbapSessionStore(firstSessionPath)
      : new SafeAbapSessionStore(),
  };
}


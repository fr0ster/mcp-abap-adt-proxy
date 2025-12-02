/**
 * Platform-specific stores for proxy
 * Uses FileServiceKeyStore and either FileSessionStore or SafeSessionStore
 * depending on the unsafe configuration parameter
 */

import { 
  FileServiceKeyStore, 
  FileSessionStore, 
  SafeSessionStore,
  IServiceKeyStore,
  ISessionStore 
} from "@mcp-abap-adt/auth-broker";

/**
 * Get platform-specific stores
 * Returns stores based on configuration:
 * - If unsafe=true: uses FileSessionStore (persists to disk)
 * - If unsafe=false: uses SafeSessionStore (in-memory, secure)
 * @param unsafe If true, use FileSessionStore. If false, use SafeSessionStore (default).
 */
export async function getPlatformStores(unsafe: boolean = false): Promise<{
  serviceKeyStore: IServiceKeyStore;
  sessionStore: ISessionStore;
}> {
  return {
    serviceKeyStore: new FileServiceKeyStore(),
    sessionStore: unsafe ? new FileSessionStore() : new SafeSessionStore(),
  };
}


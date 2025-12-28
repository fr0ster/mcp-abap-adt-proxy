/**
 * Direct Cloud Router - Routes requests directly to cloud ABAP systems
 *
 * For requests with x-sap-destination (not "sk"), routes directly to cloud ABAP
 * using the same approach as mcp-abap-adt
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  type AbapConnection,
  createAbapConnection,
} from '@mcp-abap-adt/connection';
import { logger } from '../lib/logger.js';
import type { RoutingDecision } from './headerAnalyzer.js';

export interface DirectCloudConfig {
  sapUrl: string;
  destination?: string;
  authType: 'jwt' | 'basic';
  jwtToken?: string;
  refreshToken?: string;
  username?: string;
  password?: string;
  sapClient?: string;
  uaaUrl?: string;
  uaaClientId?: string;
  uaaClientSecret?: string;
}

/**
 * Convert validated auth config to direct cloud config
 */
export function createDirectCloudConfig(
  routingDecision: RoutingDecision,
  _headers: IncomingHttpHeaders,
): DirectCloudConfig | null {
  // Proxy validates only x-btp-destination and x-mcp-destination headers
  // This function is not used in the current proxy implementation
  // as proxy passes all other headers directly to MCP server
  logger?.warn('Direct cloud routing is not supported in proxy mode', {
    type: 'DIRECT_CLOUD_CONFIG_ERROR',
    strategy: routingDecision.strategy,
  });
  return null;
}

/**
 * Connection cache for direct cloud connections
 */
const connectionCache = new Map<
  string,
  {
    connection: AbapConnection;
    configSignature: string;
    lastUsed: Date;
  }
>();

/**
 * Generate cache key for connection
 */
function generateConnectionCacheKey(
  sessionId: string,
  config: DirectCloudConfig,
): string {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256');
  hash.update(sessionId);
  hash.update(config.sapUrl);
  hash.update(config.destination || '');
  hash.update(config.authType);
  hash.update(config.sapClient || '');
  return hash.digest('hex');
}

/**
 * Clean up old connections from cache
 */
function cleanupConnectionCache(): void {
  const now = new Date();
  const maxAge = 60 * 60 * 1000; // 1 hour

  for (const [key, entry] of connectionCache.entries()) {
    const age = now.getTime() - entry.lastUsed.getTime();
    if (age > maxAge) {
      logger?.debug('Cleaning up old connection cache entry', {
        type: 'CONNECTION_CACHE_CLEANUP',
        key: key.substring(0, 16),
      });
      connectionCache.delete(key);
    }
  }
}

/**
 * Get or create ABAP connection for direct cloud routing
 */
export async function getDirectCloudConnection(
  sessionId: string,
  config: DirectCloudConfig,
  authBroker?: AuthBroker,
): Promise<AbapConnection> {
  // Clean up old entries periodically
  if (connectionCache.size > 100) {
    cleanupConnectionCache();
  }

  const cacheKey = generateConnectionCacheKey(sessionId, config);
  let entry = connectionCache.get(cacheKey);

  // If we have a destination and no SAP URL, load it from AuthBroker
  if (config.destination && !config.sapUrl && authBroker) {
    try {
      // Get token from AuthBroker (this will also provide the SAP URL from destination)
      const token = await authBroker.getToken(config.destination);
      config.jwtToken = token;

      // Load destination config to get SAP URL from AuthBroker
      // AuthBroker stores session data, we can access it through the broker
      // For now, we'll rely on the token being valid and the URL being set from destination
      // The actual URL will be loaded when we create the connection
    } catch (error) {
      logger?.error('Failed to load destination config from AuthBroker', {
        type: 'AUTH_BROKER_LOAD_ERROR',
        destination: config.destination,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  if (!entry || entry.configSignature !== cacheKey) {
    logger?.debug('Creating new direct cloud connection', {
      type: 'DIRECT_CLOUD_CONNECTION_CREATE',
      sessionId: sessionId.substring(0, 8),
      destination: config.destination,
      sapUrl: config.sapUrl,
    });

    // Dispose old connection if exists
    if (entry) {
      // Connection disposal will be handled by connection package
    }

    // Create SAP config for connection
    const sapConfig = {
      url: config.sapUrl,
      authType: config.authType,
      jwtToken: config.jwtToken,
      refreshToken: config.refreshToken,
      username: config.username,
      password: config.password,
      sapClient: config.sapClient,
      uaaUrl: config.uaaUrl,
      uaaClientId: config.uaaClientId,
      uaaClientSecret: config.uaaClientSecret,
    };

    // Create connection
    const connectionSessionId = `mcp-proxy-direct-${sessionId}`;
    // Create token refresher from AuthBroker if available
    const tokenRefresher = authBroker && config.destination
      ? {
          getToken: async () => {
            return await authBroker.getToken(config.destination!);
          },
          refreshToken: async () => {
            return await authBroker.getToken(config.destination!);
          },
        }
      : undefined;
    const connection = createAbapConnection(
      sapConfig,
      logger, // Use our logger
      connectionSessionId,
      tokenRefresher,
    );

    // Connection will be established lazily on first request
    // No need to call connect() explicitly

    entry = {
      connection,
      configSignature: cacheKey,
      lastUsed: new Date(),
    };

    connectionCache.set(cacheKey, entry);
  } else {
    entry.lastUsed = new Date();
    logger?.debug('Reusing cached direct cloud connection', {
      type: 'DIRECT_CLOUD_CONNECTION_REUSE',
      sessionId: sessionId.substring(0, 8),
    });
  }

  return entry.connection;
}

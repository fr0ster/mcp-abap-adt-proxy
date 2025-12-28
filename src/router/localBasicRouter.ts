/**
 * Local Basic Router - Handles basic authentication requests locally
 *
 * For requests with x-sap-auth-type: "basic", handles locally without proxying
 */

import type { IncomingHttpHeaders } from 'node:http';
import {
  type AbapConnection,
  createAbapConnection,
} from '@mcp-abap-adt/connection';
import { logger } from '../lib/logger.js';
import type { RoutingDecision } from './headerAnalyzer.js';

export interface LocalBasicConfig {
  sapUrl: string;
  username: string;
  password: string;
  sapClient?: string;
}

/**
 * Convert validated auth config to local basic config
 */
export function createLocalBasicConfig(
  routingDecision: RoutingDecision,
  _headers: IncomingHttpHeaders,
): LocalBasicConfig | null {
  // Proxy validates only x-btp-destination and x-mcp-destination headers
  // This function is not used in the current proxy implementation
  // as proxy passes all other headers directly to MCP server
  logger?.warn('Local basic routing is not supported in proxy mode', {
    type: 'LOCAL_BASIC_CONFIG_ERROR',
    strategy: routingDecision.strategy,
  });
  return null;
}

/**
 * Connection cache for local basic connections
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
  config: LocalBasicConfig,
): string {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256');
  hash.update(sessionId);
  hash.update(config.sapUrl);
  hash.update(config.username);
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
      logger?.debug('Cleaning up old local basic connection cache entry', {
        type: 'LOCAL_BASIC_CACHE_CLEANUP',
        key: key.substring(0, 16),
      });
      connectionCache.delete(key);
    }
  }
}

/**
 * Get or create ABAP connection for local basic auth
 */
export async function getLocalBasicConnection(
  sessionId: string,
  config: LocalBasicConfig,
): Promise<AbapConnection> {
  // Clean up old entries periodically
  if (connectionCache.size > 100) {
    cleanupConnectionCache();
  }

  const cacheKey = generateConnectionCacheKey(sessionId, config);
  let entry = connectionCache.get(cacheKey);

  if (!entry || entry.configSignature !== cacheKey) {
    logger?.debug('Creating new local basic connection', {
      type: 'LOCAL_BASIC_CONNECTION_CREATE',
      sessionId: sessionId.substring(0, 8),
      sapUrl: config.sapUrl,
    });

    // Dispose old connection if exists
    if (entry) {
      // Connection disposal will be handled by connection package
    }

    // Create SAP config for connection
    const sapConfig = {
      url: config.sapUrl,
      authType: 'basic' as const,
      username: config.username,
      password: config.password,
      client: config.sapClient,
    };

    // Create connection
    const connectionSessionId = `mcp-proxy-basic-${sessionId}`;
    const connection = createAbapConnection(
      sapConfig,
      logger, // Use our logger
      connectionSessionId,
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
    logger?.debug('Reusing cached local basic connection', {
      type: 'LOCAL_BASIC_CONNECTION_REUSE',
      sessionId: sessionId.substring(0, 8),
    });
  }

  return entry.connection;
}

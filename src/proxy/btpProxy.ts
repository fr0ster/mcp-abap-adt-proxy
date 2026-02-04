/**
 * BTP Proxy - Proxies requests to MCP servers with JWT authentication
 *
 * For requests with x-btp-destination, proxies to target MCP server
 * with JWT token from auth-broker (XSUAA/BTP)
 */

import { AuthBroker, type ILogger } from '@mcp-abap-adt/auth-broker';
import { AuthorizationCodeProvider } from '@mcp-abap-adt/auth-providers';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces';
import {
  HEADER_ACCEPT,
  HEADER_AUTHORIZATION,
  HEADER_BTP_DESTINATION,
  HEADER_CONTENT_TYPE,
  HEADER_SAP_CLIENT,
  HEADER_SAP_DESTINATION_SERVICE,
} from '@mcp-abap-adt/interfaces';
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { loadConfig, type ProxyConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { getPlatformStores } from '../lib/stores.js';
import type { RoutingDecision } from '../router/headerAnalyzer.js';

/**
 * Adapter to convert proxy Logger to ILogger interface expected by AuthBroker
 */
const loggerAdapter: ILogger = {
  debug: (message: string, meta?: unknown) =>
    logger?.debug(
      message,
      meta && typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)
        : undefined,
    ),
  info: (message: string, meta?: unknown) =>
    logger?.info(
      message,
      meta && typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)
        : undefined,
    ),
  warn: (message: string, meta?: unknown) =>
    logger?.warn(
      message,
      meta && typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)
        : undefined,
    ),
  error: (message: string, meta?: unknown) =>
    logger?.error(
      message,
      meta && typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)
        : undefined,
    ),
};

import {
  CircuitBreaker,
  createErrorResponse,
  isTokenExpirationError,
  type RetryOptions,
  retryWithBackoff,
} from '../lib/errorHandler.js';

/**
 * Check if error messages should be written to stderr
 * Only output in verbose mode and not in test environment
 */
export function shouldWriteStderr(): boolean {
  const verboseMode =
    process.env.MCP_PROXY_VERBOSE === 'true' ||
    process.env.DEBUG === 'true' ||
    process.env.DEBUG?.includes('mcp-proxy') === true;
  const isTestEnv =
    process.env.NODE_ENV === 'test' ||
    process.env.JEST_WORKER_ID !== undefined ||
    typeof (globalThis as { jest?: unknown }).jest !== 'undefined';
  return verboseMode && !isTestEnv;
}

export interface GenericProxyRequest {
  method: string;
  url?: string; // Request URL/Path
  data?: unknown; // Generic body (JSON or parsed object)
  id?: string | number | null; // Optional ID for logging
  [key: string]: unknown; // Allow other properties
}

// Legacy support alias
export type ProxyRequest = GenericProxyRequest;

export interface ProxyResponse {
  jsonrpc: string;
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * BTP Proxy Client
 */
export class BtpProxy {
  private axiosInstance: AxiosInstance;
  private defaultBtpAuthBroker: AuthBroker;
  private btpAuthBrokers: Map<string, AuthBroker> = new Map();
  private tokenCache: Map<string, { token: string; expiresAt: number }> =
    new Map();
  private readonly TOKEN_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  private circuitBreaker: CircuitBreaker;
  private config: ProxyConfig;
  private unsafe: boolean;

  constructor(defaultBtpAuthBroker: AuthBroker, config?: Partial<ProxyConfig>) {
    this.defaultBtpAuthBroker = defaultBtpAuthBroker;
    this.unsafe = config?.unsafe ?? false;

    // Use provided config if available (from YAML or CLI/ENV, already loaded in index.ts)
    // If no config provided, load from CLI/ENV as fallback
    if (config) {
      this.config = config as ProxyConfig;
      logger?.debug('Using provided config in BtpProxy constructor', {
        type: 'CONFIG_PROVIDED',
        btpDestination: this.config.btpDestination,
        configKeys: Object.keys(this.config),
      });
    } else {
      // Fallback: load from CLI/ENV (should not happen if called from index.ts)
      this.config = loadConfig();
      logger?.info(
        'Using fallback config from CLI/ENV in BtpProxy constructor',
        {
          type: 'CONFIG_FALLBACK',
        },
      );
    }

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold || 5,
      this.config.circuitBreakerTimeout || 60000,
    );

    // Create axios instance without baseURL - we'll use full URLs from BTP destination
    const https = require('node:https');
    this.axiosInstance = axios.create({
      timeout: this.config.requestTimeout || 60000,
      headers: {
        [HEADER_CONTENT_TYPE]: 'application/json',
      },
      httpsAgent: new https.Agent({
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
        keepAlive: true,
      }),
    });

    // Add request interceptor for logging
    this.axiosInstance.interceptors.request.use(
      (config) => {
        logger?.debug('Proxying request to target service', {
          type: 'PROXY_REQUEST',
          method: config.method,
          url: config.url,
          baseURL: config.baseURL,
        });
        return config;
      },
      (error) => {
        logger?.error('Request interceptor error', {
          type: 'MCP_PROXY_REQUEST_ERROR',
          error: error instanceof Error ? error.message : String(error),
        });
        return Promise.reject(error);
      },
    );

    // Add response interceptor for logging
    this.axiosInstance.interceptors.response.use(
      (response) => {
        logger?.debug('Received response from target service', {
          type: 'PROXY_RESPONSE',
          status: response.status,
          url: response.config.url,
        });
        return response;
      },
      (error) => {
        logger?.error('Response interceptor error', {
          type: 'MCP_PROXY_RESPONSE_ERROR',
          error: error instanceof Error ? error.message : String(error),
          status: error.response?.status,
          url: error.config?.url,
        });
        return Promise.reject(error);
      },
    );
  }

  /**
   * Initialize authentication for destination (eager auth)
   * This triggers the browser authentication flow immediately if needed.
   */
  public async initialize(destination: string): Promise<void> {
    logger?.info('Initializing BTP proxy authentication', {
      type: 'BTP_PROXY_INIT',
      destination,
    });
    try {
      // Just getting the token will trigger authentication
      await this.getJwtToken(destination);
      logger?.info('BTP proxy authentication initialized successfully', {
        type: 'BTP_PROXY_INIT_SUCCESS',
        destination,
      });
    } catch (error) {
      logger?.error('Failed to initialize BTP proxy authentication', {
        type: 'BTP_PROXY_INIT_ERROR',
        destination,
        error: error instanceof Error ? error.message : String(error),
      });
      // We don't throw here to avoid crashing the server on startup,
      // but the user will see the error in logs/stderr (via getJwtToken)
    }
  }

  /**
   * Get or create BTP auth broker for specific destination
   * If destination is not provided, returns default broker
   * If broker doesn't exist in map, creates new one and stores it
   */
  private async getOrCreateBtpAuthBroker(
    destination?: string,
    targetUrl?: string,
  ): Promise<AuthBroker> {
    // If no destination, use default broker
    if (!destination) {
      return this.defaultBtpAuthBroker;
    }

    // Check if broker exists in map
    let broker = this.btpAuthBrokers.get(destination);
    if (broker) {
      return broker;
    }

    // Create new broker for this destination
    logger?.info('Creating new BTP auth broker for destination', {
      type: 'BTP_BROKER_CREATE',
      destination,
    });

    const { serviceKeyStore, sessionStore } = await getPlatformStores(
      this.unsafe,
    );

    // We must manually load the credentials because AuthorizationCodeProvider validates them in constructor
    let authConfig: IAuthorizationConfig | null = null;
    try {
      // Try service key store first
      if (serviceKeyStore) {
        authConfig = await serviceKeyStore.getAuthorizationConfig(destination);
      }
      // If not found, try session store (though less likely for initial setup)
      if (!authConfig) {
        authConfig = await sessionStore.getAuthorizationConfig(destination);
      }
    } catch (error) {
      logger?.warn('Failed to load auth config for provider initialization', {
        error: error instanceof Error ? error.message : String(error),
        destination,
      });
    }

    if (!authConfig) {
      logger?.error('Service key not found for destination', {
        destination,
        hint: 'Ensure service key file exists in ~/.config/mcp-abap-adt/service-keys/',
      });
      // We cannot proceed without config, but we'll let it fail with a clear message
      // Or we could throw here.
      // If we don't provide config, provider will throw "Missing required fields".
    }

    // Always use AuthorizationCodeProvider (enforced)
    // Map IAuthorizationConfig (uaaClientId) to ProviderConfig (clientId)
    // Default redirectPort to 3333 to avoid conflict with main proxy port (default 3001)
    const providerConfig: any = {
      browser: this.config.browser,
      redirectPort: this.config.browserAuthPort || 3333,
      ...(authConfig
        ? {
          uaaUrl: authConfig.uaaUrl,
          clientId: authConfig.uaaClientId,
          clientSecret: authConfig.uaaClientSecret,
        }
        : {}),
    };

    const tokenProvider = new AuthorizationCodeProvider(providerConfig);

    broker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider,
      },
      this.config.browser, // Pass configured browser (default: 'system')
      logger,
    );

    this.btpAuthBrokers.set(destination, broker);

    return this.ensureSessionServiceUrl(broker, destination, targetUrl);
  }

  /**
   * Helper to ensure valid serviceUrl in session if override provided
   */
  private async ensureSessionServiceUrl(
    broker: AuthBroker,
    destination: string,
    targetUrl?: string,
  ): Promise<AuthBroker> {
    const activeTargetUrl = targetUrl || this.config.targetUrl;

    if (!activeTargetUrl) {
      return broker;
    }

    try {
      // Check if current connection config exists
      const currentConn = await broker.getConnectionConfig(destination);

      // We need to ensure we have a valid session with BOTH serviceUrl AND auth config.
      // Even if serviceUrl matches, the auth config might be missing from the session
      // (which causes ClientCredentialsProvider to fail if initialized with empty config).

      // Cast to any to access potentially private methods if interface restricted
      // biome-ignore lint/suspicious/noExplicitAny: Accessing internal methods for safe injection
      const brokerAny = broker as any;

      let authConfig = await broker.getAuthorizationConfig(destination);
      if (!authConfig) {
        try {
          if (
            typeof brokerAny.getAuthorizationConfigFromServiceKey === 'function'
          ) {
            authConfig =
              await brokerAny.getAuthorizationConfigFromServiceKey(destination);
          }
        } catch (e) {
          logger?.debug('Could not find auth config for session update', {
            error: String(e),
          });
        }
      }

      if (!authConfig) {
        authConfig = {
          uaaUrl: 'https://placeholder.authentication.sap.hana.ondemand.com',
          uaaClientId: 'placeholder',
          uaaClientSecret: 'placeholder',
        } as any;
        logger?.info('Using placeholder auth config for session injection', {
          type: 'BTP_SESSION_PLACEHOLDER',
          destination,
          targetUrl: activeTargetUrl,
        });
      }

      if (authConfig) {
        const newConn = {
          ...(currentConn || {}),
          serviceUrl: activeTargetUrl,
          authType: 'jwt' as any,
          // Map XSUAA keys to ClientCredentialsProvider keys
          clientId: authConfig.uaaClientId,
          clientSecret: authConfig.uaaClientSecret,
          uaaUrl: authConfig.uaaUrl,
        };

        if (typeof brokerAny.saveTokenToSession === 'function') {
          await brokerAny.saveTokenToSession(destination, newConn, authConfig);
          logger?.info('Injected targetUrl and auth config into BTP session', {
            type: 'BTP_SESSION_INJECTION',
            destination,
            url: activeTargetUrl,
            hasClientId: !!newConn.clientId,
          });
        } else {
          logger?.error('saveTokenToSession is not a function on broker', {
            type: 'BTP_SESSION_METHOD_MISSING',
            keys: Object.keys(brokerAny)
          });
        }
      }
    } catch (error) {
      logger?.error('Failed to inject targetUrl into session', {
        type: 'BTP_SESSION_INJECTION_ERROR',
        destination,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return broker;
  }

  /**
   * Get JWT token for BTP destination from auth-broker with retry and token refresh
   * @param destination Destination name
   * @param forceRefresh Force token refresh
   */
  private async getJwtToken(
    destination: string,
    forceRefresh: boolean = false,
  ): Promise<string> {
    logger?.info('Getting JWT token', {
      type: 'JWT_TOKEN_GET_START',
      destination,
    });

    const authBroker = await this.getOrCreateBtpAuthBroker(destination);

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = this.tokenCache.get(destination);
      if (cached && cached.expiresAt > Date.now()) {
        logger?.debug('Using cached JWT token', {
          type: 'JWT_TOKEN_CACHE_HIT',
          destination,
        });
        return cached.token;
      }
    }

    // Retry logic for token retrieval
    const retryOptions: RetryOptions = {
      maxRetries: this.config.maxRetries || 3,
      retryDelay: this.config.retryDelay || 1000,
      retryableStatusCodes: [500, 502, 503, 504],
    };

    try {
      const token = await retryWithBackoff(async () => {
        // Clear cache if force refresh
        if (forceRefresh) {
          this.tokenCache.delete(destination);
        }

        logger?.debug('Getting JWT token from auth-broker', {
          type: 'JWT_TOKEN_REQUEST_START',
          destination,
          forceRefresh,
        });

        // Get token from auth-broker
        const token = await authBroker.getToken(destination);

        // Cache token (assume it's valid for 30 minutes)
        this.tokenCache.set(destination, {
          token,
          expiresAt: Date.now() + this.TOKEN_CACHE_TTL,
        });

        logger?.debug('Retrieved JWT token from auth-broker', {
          type: 'JWT_TOKEN_RETRIEVED',
          destination,
          forceRefresh,
        });

        return token;
      }, retryOptions);

      return token;
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : String(error);

      // Rewrite error message to remove .env file references (proxy only uses service keys)
      if (errorMessage.includes('.env') || errorMessage.includes('mcp.env')) {
        const searchedInMatch = errorMessage.match(
          /Searched in:\s*([\s\S]*?)(?:\n|$)/,
        );
        const searchedPaths = searchedInMatch
          ? searchedInMatch[1]
            .trim()
            .split('\n')
            .map((p) => p.trim().replace(/^-\s*/, ''))
            .filter((p) => p)
          : [];

        errorMessage =
          `Service key file not found for destination "${destination}".\n` +
          `Please create service key file: ${destination}.json\n`;

        if (searchedPaths.length > 0) {
          errorMessage += `Searched in:\n`;
          searchedPaths.forEach((path) => {
            errorMessage += `  - ${path}\n`;
          });
        } else {
          const isWindows = process.platform === 'win32';
          const homeDir = require('node:os').homedir();
          const defaultPath = isWindows
            ? require('node:path').join(
              homeDir,
              'Documents',
              'mcp-abap-adt',
              'service-keys',
            )
            : require('node:path').join(
              homeDir,
              '.config',
              'mcp-abap-adt',
              'service-keys',
            );
          errorMessage += `Searched in:\n  - ${defaultPath}\n`;
        }
      }

      logger?.error('Failed to get JWT token from auth-broker after retries', {
        type: 'JWT_TOKEN_ERROR',
        destination,
        error: errorMessage,
      });
      if (shouldWriteStderr()) {
        process.stderr.write(`[MCP Proxy] ✗ ${errorMessage}`);
      }

      throw new Error(errorMessage);
    }
  }

  /**
   * Helper function to extract string value from header (handles arrays)
   */
  private getHeaderValue(
    headerValue: string | string[] | undefined,
  ): string | undefined {
    if (!headerValue) return undefined;
    if (Array.isArray(headerValue)) {
      return headerValue[0]?.trim();
    }
    return typeof headerValue === 'string' ? headerValue.trim() : undefined;
  }

  /**
   * Build proxy request with JWT token (BTP authentication only)
   *
   * Process flow:
   *
   * 1. BTP Authentication (XSUAA):
   *    1.1 If x-btp-destination header exists:
   *        - Check map for broker with key = destination, get or create, save to map
   *        - Get token from xsuaa broker
   *        - Add/replace Authorization: Bearer <token> header
   *    1.2 If header doesn't exist but --btp parameter exists:
   *        - Use destination from parameter, get or create broker, save to map
   *        - Get token from xsuaa broker
   *        - Add/replace Authorization: Bearer <token> header
   *    1.3 If neither header nor parameter:
   *        - Do nothing, pass request further
   */
  private async buildProxyRequest(
    originalRequest: ProxyRequest,
    routingDecision: RoutingDecision,
    originalHeaders: Record<string, string | string[] | undefined>,
    forceTokenRefresh: boolean = false,
  ): Promise<AxiosRequestConfig> {
    logger?.info('=== BUILD PROXY REQUEST - ORIGINAL ===', {
      type: 'BUILD_PROXY_REQUEST_ORIGINAL',
      originalRequestId: originalRequest.id,
      originalRequestIdType: typeof originalRequest.id,
      originalRequestMethod: originalRequest.method,
      fullOriginalRequest: JSON.stringify(originalRequest),
    });

    // Build headers for target MCP server
    const proxyHeaders: Record<string, string> = {
      [HEADER_CONTENT_TYPE]: 'application/json',
      [HEADER_ACCEPT]:
        'application/json, application/x-ndjson, text/event-stream',
    };

    // ============================================
    // BTP Authentication (XSUAA)
    // ============================================
    const btpDestinationHeader = this.getHeaderValue(
      originalHeaders[HEADER_BTP_DESTINATION],
    );
    const btpDestinationFromParam =
      routingDecision.btpDestination && !btpDestinationHeader
        ? routingDecision.btpDestination
        : undefined;

    let btpDestination: string | undefined;
    if (btpDestinationHeader) {
      btpDestination = btpDestinationHeader;
      logger?.debug('Using x-btp-destination from header', {
        type: 'BTP_DESTINATION_FROM_HEADER',
        destination: btpDestination,
      });
    } else if (btpDestinationFromParam) {
      btpDestination = btpDestinationFromParam;
      logger?.debug('Using x-btp-destination from parameter', {
        type: 'BTP_DESTINATION_FROM_PARAM',
        destination: btpDestination,
      });
    }

    if (btpDestination) {
      const _btpBroker = await this.getOrCreateBtpAuthBroker(btpDestination);

      const existingAuth =
        originalHeaders[HEADER_AUTHORIZATION.toLowerCase()] ||
        originalHeaders[HEADER_AUTHORIZATION];
      const hasExistingAuth = !!existingAuth;

      const authToken = await this.getJwtToken(
        btpDestination,
        forceTokenRefresh,
      );

      proxyHeaders[HEADER_AUTHORIZATION] = `Bearer ${authToken}`;

      logger?.debug(
        hasExistingAuth
          ? 'Replaced existing Authorization header with BTP token'
          : 'Added BTP Cloud authorization token',
        {
          type: hasExistingAuth
            ? 'BTP_AUTH_TOKEN_REPLACED'
            : 'BTP_AUTH_TOKEN_ADDED',
          destination: btpDestination,
          hadExistingAuth: hasExistingAuth,
        },
      );
    } else {
      logger?.debug('No BTP destination - skipping authentication', {
        type: 'BTP_AUTH_SKIPPED',
      });
    }

    // Preserve other SAP headers if provided by client
    const sapHeaders = [HEADER_SAP_CLIENT, HEADER_SAP_DESTINATION_SERVICE];

    for (const headerName of sapHeaders) {
      const value = originalHeaders[headerName];
      if (value) {
        proxyHeaders[headerName] = Array.isArray(value) ? value[0] : value;
      }
    }

    // Get MCP server URL from BTP destination service key
    let baseUrl: string | undefined;

    if (btpDestination) {
      try {
        const btpBroker = await this.getOrCreateBtpAuthBroker(
          btpDestination,
          routingDecision.targetUrl,
        );
        const connConfig = await btpBroker.getConnectionConfig(btpDestination);

        // Use service key URL as base (if available)
        if (connConfig?.serviceUrl) {
          baseUrl = connConfig.serviceUrl;
          logger?.debug('Using MCP URL from BTP destination service key', {
            type: 'MCP_URL_FROM_BTP_DESTINATION',
            destination: btpDestination,
            url: baseUrl,
          });
        } else {
          logger?.warn(
            'BTP destination service key does not contain service URL',
            {
              type: 'BTP_DESTINATION_NO_URL',
              destination: btpDestination,
            },
          );
        }
      } catch (error) {
        logger?.warn('Failed to get URL from BTP destination service key', {
          type: 'BTP_DESTINATION_URL_ERROR',
          destination: btpDestination,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Apply Target URL override logic
    if (routingDecision.targetUrl) {
      if (baseUrl) {
        logger?.debug('Overriding service key URL with explicit target URL', {
          type: 'TARGET_URL_OVERRIDE',
          url: routingDecision.targetUrl,
          serviceKeyUrl: baseUrl,
        });
      } else {
        logger?.debug('Using explicit target URL from configuration', {
          type: 'TARGET_URL_FROM_CONFIG',
          url: routingDecision.targetUrl,
        });
      }
      baseUrl = routingDecision.targetUrl;
    }

    if (!baseUrl) {
      throw new Error(
        'Cannot determine target URL: provide btpDestination with service key containing URL OR use --target-url',
      );
    }

    // Construct full MCP endpoint URL
    let fullUrl: string;

    // Determine the path to append
    // If original request has a URL/path, use it. Otherwise default to nothing/root.
    const requestPath = originalRequest.url || '';

    // Check if we should use URL as-is
    // 1. If it already looks like an MCP URL
    // 2. OR if it was explicitly provided via targetUrl (user knows best)
    const isExplicitTarget = !!routingDecision.targetUrl;
    const hasMcpPath =
      baseUrl.includes('/mcp/') ||
      baseUrl.endsWith('/mcp') ||
      baseUrl.includes('/mcp/stream/');

    if (isExplicitTarget) {
      // Explicit Target URL logic (as per User request):
      // "whatever endpoint [proxy] received, it adds to the target URL"
      // Use join logic to avoid double slashes and ensure correctness

      // Remove trailing slash from base
      const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
      // Ensure path starts with slash if not empty
      const path = requestPath.startsWith('/')
        ? requestPath
        : `/${requestPath}`;

      // If requestPath is empty or just '/', ensure we don't end up with empty path if base is root
      // But typically we just append.
      fullUrl = `${base}${path}`;

      logger?.debug('Using explicit target URL with forwarded path', {
        type: 'TARGET_URL_PATH_FORWARDING',
        base,
        path,
        final: fullUrl,
      });
    } else if (hasMcpPath) {
      // Use as-is (strip trailing slash if present, though typically not needed if strictly as-is, but good practice for consistency)
      fullUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

      logger?.debug('Using target URL as-is', {
        type: 'MCP_URL_AS_IS',
        original: baseUrl,
        final: fullUrl,
        reason: 'path detection',
      });
    } else {
      // Default: append MCP path
      const mcpPath = '/mcp/stream/http';
      fullUrl = baseUrl.endsWith('/')
        ? `${baseUrl.slice(0, -1)}${mcpPath}`
        : `${baseUrl}${mcpPath}`;

      logger?.debug('Appended MCP path to base URL', {
        type: 'MCP_URL_APPENDED',
        original: baseUrl,
        final: fullUrl,
      });
    }

    const builtHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(proxyHeaders)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('token') ||
        lowerKey.includes('authorization') ||
        lowerKey.includes('password') ||
        lowerKey.includes('secret')
      ) {
        builtHeaders[key] = value
          ? `${String(value).substring(0, 20)}...`
          : '[REDACTED]';
      } else {
        builtHeaders[key] = String(value || '');
      }
    }

    const sanitizedRequestParams: Record<string, unknown> = {};
    const requestData = originalRequest.data as Record<string, unknown>;

    if (
      requestData &&
      requestData.params &&
      typeof requestData.params === 'object' &&
      requestData.params !== null
    ) {
      const params = requestData.params as Record<string, unknown>;
      // ... (existing sanitization logic) ...
      if (
        params.arguments &&
        typeof params.arguments === 'object' &&
        params.arguments !== null
      ) {
        sanitizedRequestParams.arguments = {};
        const sanitizedArgs = sanitizedRequestParams.arguments as Record<
          string,
          unknown
        >;
        for (const [key, value] of Object.entries(params.arguments)) {
          const lowerKey = key.toLowerCase();
          if (
            lowerKey.includes('password') ||
            lowerKey.includes('token') ||
            lowerKey.includes('secret')
          ) {
            sanitizedArgs[key] = '[REDACTED]';
          } else {
            sanitizedArgs[key] = value;
          }
        }
      }
      for (const [key, value] of Object.entries(params)) {
        if (key === 'arguments') continue;
        sanitizedRequestParams[key] = value;
      }
    }

    logger?.info('=== BUILDING PROXY REQUEST ===', {
      type: 'PROXY_REQUEST_BUILT',
      btpDestination: btpDestination,
      url: fullUrl,
      headers: builtHeaders,
      baseUrl,
      fullUrl,
      hasAuthToken: !!proxyHeaders[HEADER_AUTHORIZATION],
      btpSource: btpDestinationHeader
        ? 'header'
        : btpDestinationFromParam
          ? 'parameter'
          : 'none',
      requestMethod: originalRequest.method,
      requestId: originalRequest.id,
      requestParams: sanitizedRequestParams,
    });

    // Return axios config with full URL
    // Use original request method
    const axiosConfig = {
      method: originalRequest.method,
      url: fullUrl,
      headers: proxyHeaders,
      data: originalRequest.data, // Send the original data (body)
    };

    logger?.debug('Axios request config', {
      type: 'AXIOS_REQUEST_CONFIG',
      method: axiosConfig.method,
      url: axiosConfig.url,
      headers: Object.keys(axiosConfig.headers),
      dataKeys: originalRequest ? Object.keys(originalRequest) : [],
    });

    return axiosConfig;
  }

  /**
   * Proxy MCP request to target server with retry, circuit breaker, and error handling
   */
  async proxyRequest(
    originalRequest: ProxyRequest,
    routingDecision: RoutingDecision,
    originalHeaders: Record<string, string | string[] | undefined>,
  ): Promise<ProxyResponse> {
    // Check circuit breaker
    if (!this.circuitBreaker.canProceed()) {
      logger?.warn('Circuit breaker is open, rejecting request', {
        type: 'CIRCUIT_BREAKER_REJECTED',
        btpDestination: routingDecision.btpDestination,
      });
      return createErrorResponse(
        originalRequest.id || null,
        -32001,
        'Service temporarily unavailable (circuit breaker open)',
        { circuitBreakerState: this.circuitBreaker.getState() },
      );
    }

    const retryOptions: RetryOptions = {
      maxRetries: this.config.maxRetries || 3,
      retryDelay: this.config.retryDelay || 1000,
      retryableStatusCodes: [500, 502, 503, 504],
    };

    try {
      const response = await retryWithBackoff(async () => {
        const forceTokenRefresh = false;

        const proxyConfig = await this.buildProxyRequest(
          originalRequest,
          routingDecision,
          originalHeaders,
          forceTokenRefresh,
        );

        // Log outgoing request details
        const outgoingHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(proxyConfig.headers || {})) {
          const lowerKey = key.toLowerCase();
          if (
            lowerKey.includes('token') ||
            lowerKey.includes('authorization') ||
            lowerKey.includes('password') ||
            lowerKey.includes('secret')
          ) {
            outgoingHeaders[key] = value
              ? `${String(value).substring(0, 20)}...`
              : '[REDACTED]';
          } else {
            outgoingHeaders[key] = String(value || '');
          }
        }

        const sanitizedOutgoingBody: Record<string, unknown> = {};
        if (proxyConfig.data && typeof proxyConfig.data === 'object') {
          if (
            proxyConfig.data.params &&
            typeof proxyConfig.data.params === 'object' &&
            proxyConfig.data.params !== null
          ) {
            const params = proxyConfig.data.params as Record<string, unknown>;
            sanitizedOutgoingBody.params = {};
            const sanitizedParams = sanitizedOutgoingBody.params as Record<
              string,
              unknown
            >;
            if (
              params.arguments &&
              typeof params.arguments === 'object' &&
              params.arguments !== null
            ) {
              sanitizedParams.arguments = {};
              const sanitizedArgs = sanitizedParams.arguments as Record<
                string,
                unknown
              >;
              for (const [key, value] of Object.entries(params.arguments)) {
                const lowerKey = key.toLowerCase();
                if (
                  lowerKey.includes('password') ||
                  lowerKey.includes('token') ||
                  lowerKey.includes('secret')
                ) {
                  sanitizedArgs[key] = '[REDACTED]';
                } else {
                  sanitizedArgs[key] = value;
                }
              }
            }
            for (const [key, value] of Object.entries(params)) {
              if (key === 'arguments') continue;
              sanitizedParams[key] = value;
            }
          }
          sanitizedOutgoingBody.method = proxyConfig.data.method;
          sanitizedOutgoingBody.id = proxyConfig.data.id;
          sanitizedOutgoingBody.jsonrpc = proxyConfig.data.jsonrpc;
        }

        logger?.info('=== SENDING PROXY REQUEST ===', {
          type: 'PROXY_REQUEST_SENDING',
          url: proxyConfig.url,
          headers: outgoingHeaders,
          body: sanitizedOutgoingBody,
        });

        const response = await this.axiosInstance.request(proxyConfig);

        this.circuitBreaker.recordSuccess();
        return response;
      }, retryOptions);

      // Return response in JSON-RPC format
      return {
        jsonrpc: '2.0',
        id: originalRequest.id || null,
        result: response.data.result,
        error: response.data.error,
      };
    } catch (error) {
      if (isTokenExpirationError(error)) {
        logger?.warn('Token expired usually handled by retry with refresh', {
          type: 'TOKEN_EXPIRED_ERROR',
        });
      }

      this.circuitBreaker.recordFailure();

      let statusCode = 500;
      let errorMessage = 'Internal Server Error';
      let errorData: unknown;

      if (axios.isAxiosError(error)) {
        statusCode = error.response?.status || 500;
        errorMessage = error.message;
        errorData = error.response?.data;

        logger?.error('Axios error in proxy request', {
          type: 'AXIOS_PROXY_ERROR',
          status: statusCode,
          message: errorMessage,
          data: errorData,
          url: error.config?.url,
        });
      } else {
        errorMessage = error instanceof Error ? error.message : String(error);
        logger?.error('Generic error in proxy request', {
          type: 'GENERIC_PROXY_ERROR',
          message: errorMessage,
        });
      }

      return createErrorResponse(
        originalRequest.id || null,
        -32000,
        `Proxy error: ${errorMessage}`,
        errorData,
      );
    }
  }

  /**
   * Create a new BtpProxy instance
   */
  public static async create(config?: Partial<ProxyConfig>): Promise<BtpProxy> {
    const loadedConfig = config ? { ...loadConfig(), ...config } : loadConfig();
    const unsafeIndex = loadedConfig.unsafe ?? false;

    const { serviceKeyStore, sessionStore } =
      await getPlatformStores(unsafeIndex);

    const defaultBtpAuthBroker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider: new AuthorizationCodeProvider({
          uaaUrl: 'https://placeholder.authentication.sap.hana.ondemand.com',
          clientId: 'placeholder',
          clientSecret: 'placeholder',
          browser: loadedConfig.browser,
          redirectPort: loadedConfig.browserAuthPort,
        }),
      },
      'none',
      loggerAdapter,
    );

    return new BtpProxy(defaultBtpAuthBroker, loadedConfig);
  }
}

/**
 * Factory function to create BtpProxy
 */
export async function createBtpProxy(
  config?: Partial<ProxyConfig>,
): Promise<BtpProxy> {
  return BtpProxy.create(config);
}

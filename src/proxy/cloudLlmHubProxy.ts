/**
 * Cloud LLM Hub Proxy - Proxies requests to cloud-llm-hub with JWT authentication
 *
 * For requests with x-btp-destination, proxies to cloud-llm-hub
 * with JWT token from auth-broker (XSUAA/BTP)
 */

import { AuthBroker, type ILogger } from '@mcp-abap-adt/auth-broker';
import { ClientCredentialsProvider } from '@mcp-abap-adt/auth-providers';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces';
import {
  HEADER_ACCEPT,
  HEADER_AUTHORIZATION,
  HEADER_BTP_DESTINATION,
  HEADER_CONTENT_TYPE,
  HEADER_MCP_URL,
  HEADER_SAP_CLIENT,
  HEADER_SAP_DESTINATION_SERVICE,
} from '@mcp-abap-adt/interfaces';
import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios';
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

export interface ProxyRequest {
  method: string;
  params?: unknown;
  id?: string | number | null;
  jsonrpc?: string;
}

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
 * Cloud LLM Hub Proxy Client
 */
export class CloudLlmHubProxy {
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
      logger?.debug('Using provided config in CloudLlmHubProxy constructor', {
        type: 'CONFIG_PROVIDED',
        btpDestination: this.config.btpDestination,
        configKeys: Object.keys(this.config),
      });
    } else {
      // Fallback: load from CLI/ENV (should not happen if called from index.ts)
      this.config = loadConfig();
      logger?.info(
        'Using fallback config from CLI/ENV in CloudLlmHubProxy constructor',
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

    // Create axios instance without baseURL - we'll use full URLs from x-mcp-url
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
        logger?.debug('Proxying request to cloud-llm-hub', {
          type: 'CLOUD_LLM_HUB_PROXY_REQUEST',
          method: config.method,
          url: config.url,
          baseURL: config.baseURL,
        });
        return config;
      },
      (error) => {
        logger?.error('Request interceptor error', {
          type: 'CLOUD_LLM_HUB_PROXY_REQUEST_ERROR',
          error: error instanceof Error ? error.message : String(error),
        });
        return Promise.reject(error);
      },
    );

    // Add response interceptor for logging
    this.axiosInstance.interceptors.response.use(
      (response) => {
        logger?.debug('Received response from cloud-llm-hub', {
          type: 'CLOUD_LLM_HUB_PROXY_RESPONSE',
          status: response.status,
          url: response.config.url,
        });
        return response;
      },
      (error) => {
        logger?.error('Response interceptor error', {
          type: 'CLOUD_LLM_HUB_PROXY_RESPONSE_ERROR',
          error: error instanceof Error ? error.message : String(error),
          status: error.response?.status,
          url: error.config?.url,
        });
        return Promise.reject(error);
      },
    );
  }

  /**
   * Get or create BTP auth broker for specific destination
   * If destination is not provided, returns default broker
   * If broker doesn't exist in map, creates new one and stores it
   */
  private async getOrCreateBtpAuthBroker(
    destination?: string,
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

    // Load auth config from service key store to create provider with correct config
    let authConfig: IAuthorizationConfig | null = null;
    try {
      authConfig = await serviceKeyStore.getAuthorizationConfig(destination);
    } catch (error) {
      logger?.debug('Could not load auth config for BTP provider', {
        destination,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Create ClientCredentialsProvider with config from service key store
    const xsuaaTokenProvider = authConfig
      ? new ClientCredentialsProvider({
          uaaUrl: authConfig.uaaUrl,
          clientId: authConfig.uaaClientId,
          clientSecret: authConfig.uaaClientSecret,
        })
      : new ClientCredentialsProvider({
          uaaUrl: 'https://placeholder.authentication.sap.hana.ondemand.com',
          clientId: 'placeholder',
          clientSecret: 'placeholder',
        });

    // Create initial session using data from service key (if available)
    try {
      const authConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      const connConfig = await serviceKeyStore.getConnectionConfig(destination);

      if (authConfig) {
        const sessionData: IAuthorizationConfig & {
          jwtToken: string;
          serviceUrl?: string;
        } = {
          ...authConfig,
          jwtToken: 'placeholder',
        };
        if (connConfig?.serviceUrl) {
          sessionData.serviceUrl = connConfig.serviceUrl;
        }

        await sessionStore.saveSession(destination, sessionData);
        logger?.debug('Created initial session for BTP destination', {
          type: 'BTP_SESSION_CREATED',
          destination,
          hasAuthConfig: !!authConfig,
          hasConnConfig: !!connConfig,
        });
      }
    } catch (error) {
      logger?.debug(
        'Could not create initial session for BTP destination (service key may not exist)',
        {
          type: 'BTP_SESSION_CREATE_SKIPPED',
          destination,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    broker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider: xsuaaTokenProvider,
      },
      'none',
      loggerAdapter,
    );

    // Store in map for future use
    this.btpAuthBrokers.set(destination, broker);
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

    // Get MCP server URL with priority:
    // 1. x-mcp-url header or --mcp-url parameter (explicit URL - highest priority)
    // 2. BTP destination service key (if btpDestination is present)
    let baseUrl: string | undefined;

    const mcpUrlHeader = this.getHeaderValue(originalHeaders[HEADER_MCP_URL]);
    const mcpUrlFromParam =
      routingDecision.mcpUrl && !mcpUrlHeader
        ? routingDecision.mcpUrl
        : undefined;

    if (mcpUrlHeader || mcpUrlFromParam) {
      baseUrl = mcpUrlHeader || mcpUrlFromParam;
      logger?.debug(
        'Using MCP URL from x-mcp-url header or --mcp-url parameter',
        {
          type: 'MCP_URL_FROM_HEADER',
          url: baseUrl,
          source: mcpUrlHeader ? 'header' : 'parameter',
        },
      );
    } else if (btpDestination) {
      try {
        const btpBroker = await this.getOrCreateBtpAuthBroker(btpDestination);
        const connConfig = await btpBroker.getConnectionConfig(btpDestination);
        baseUrl = connConfig?.serviceUrl;
        if (baseUrl) {
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

    if (!baseUrl) {
      throw new Error(
        'Cannot determine MCP server URL: provide x-mcp-url/--mcp-url, or use btpDestination with service key containing URL',
      );
    }

    // Construct full MCP endpoint URL
    let fullUrl: string;
    if (
      baseUrl.includes('/mcp/') ||
      baseUrl.endsWith('/mcp') ||
      baseUrl.includes('/mcp/stream/')
    ) {
      fullUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
      logger?.debug('Using MCP URL as-is (already contains path)', {
        type: 'MCP_URL_AS_IS',
        original: baseUrl,
        final: fullUrl,
      });
    } else {
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
    if (
      originalRequest.params &&
      typeof originalRequest.params === 'object' &&
      originalRequest.params !== null
    ) {
      const params = originalRequest.params as Record<string, unknown>;
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
      mcpUrl: mcpUrlHeader || mcpUrlFromParam,
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
    const axiosConfig = {
      method: 'POST' as const,
      url: fullUrl,
      headers: proxyHeaders,
      data: originalRequest,
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
   * Proxy MCP request to cloud-llm-hub with retry, circuit breaker, and error handling
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

        logger?.info('=== SENDING REQUEST TO MCP SERVER ===', {
          type: 'PROXY_REQUEST_SENDING',
          url: proxyConfig.url,
          method: proxyConfig.method,
          headers: outgoingHeaders,
          body: sanitizedOutgoingBody,
        });

        const response: AxiosResponse<ProxyResponse> =
          await this.axiosInstance.request(proxyConfig);

        // Record success in circuit breaker
        this.circuitBreaker.recordSuccess();

        // Log raw response first
        const dataString =
          typeof response.data === 'string'
            ? (response.data as string).substring(0, 500)
            : undefined;
        const dataKeys =
          response.data &&
          typeof response.data === 'object' &&
          !Array.isArray(response.data)
            ? Object.keys(response.data)
            : undefined;

        logger?.info('=== RAW RESPONSE FROM MCP SERVER ===', {
          type: 'RAW_RESPONSE_FROM_MCP_SERVER',
          status: response.status,
          statusText: response.statusText,
          headers: Object.keys(response.headers || {}),
          contentType: response.headers?.['content-type'],
          dataType: typeof response.data,
          dataIsNull: response.data === null,
          dataIsUndefined: response.data === undefined,
          dataString: dataString,
          dataKeys: dataKeys,
          fullData: JSON.stringify(response.data),
        });

        // Log response details
        const sanitizedResponse: Record<string, unknown> = {
          status: response.status,
          statusText: response.statusText,
          jsonrpc: response.data?.jsonrpc,
          id: response.data?.id,
        };
        if (response.data?.result) {
          sanitizedResponse.result =
            typeof response.data.result === 'object'
              ? '[OBJECT]'
              : response.data.result;
        }
        if (response.data?.error) {
          sanitizedResponse.error = {
            code: response.data.error.code,
            message: response.data.error.message,
            data: response.data.error.data,
          };
        }

        logger?.info('=== RESPONSE FROM MCP SERVER (AXIOS) ===', {
          type: 'PROXY_RESPONSE_RECEIVED_AXIOS',
          response: sanitizedResponse,
          hasResult: !!response.data?.result,
          hasError: !!response.data?.error,
        });

        return response;
      }, retryOptions);

      return response.data;
    } catch (error) {
      // Record failure in circuit breaker
      this.circuitBreaker.recordFailure();

      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as {
          response?: {
            status?: number;
            statusText?: string;
            data?: unknown;
            headers?: Record<string, unknown>;
          };
          config?: { url?: string; method?: string };
        };
        logger?.error('Request failed', {
          type: 'PROXY_REQUEST_FAILED',
          status: axiosError.response?.status,
          statusText: axiosError.response?.statusText,
          url: axiosError.config?.url,
        });
        logger?.debug('Axios error details', {
          type: 'AXIOS_ERROR_DETAILS',
          status: axiosError.response?.status,
          statusText: axiosError.response?.statusText,
          url: axiosError.config?.url,
          method: axiosError.config?.method,
          responseData: axiosError.response?.data,
          responseHeaders: axiosError.response?.headers,
        });
      }

      // Handle token expiration
      if (isTokenExpirationError(error)) {
        logger?.warn('Token expiration detected, will retry with fresh token', {
          type: 'TOKEN_EXPIRATION_DETECTED',
          btpDestination: routingDecision.btpDestination,
        });

        try {
          const proxyConfig = await this.buildProxyRequest(
            originalRequest,
            routingDecision,
            originalHeaders,
            true,
          );

          const response: AxiosResponse<ProxyResponse> =
            await this.axiosInstance.request(proxyConfig);
          this.circuitBreaker.recordSuccess();
          return response.data;
        } catch (retryError) {
          logger?.error('Failed to retry with fresh token', {
            type: 'TOKEN_REFRESH_RETRY_FAILED',
            error:
              retryError instanceof Error
                ? retryError.message
                : String(retryError),
          });
        }
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const statusCode =
        axios.isAxiosError(error) && error.response?.status
          ? error.response.status
          : undefined;

      logger?.error('Failed to proxy request to cloud-llm-hub', {
        type: 'PROXY_REQUEST_ERROR',
        error: errorMessage,
        status: statusCode,
        circuitBreakerState: this.circuitBreaker.getState(),
      });

      if (shouldWriteStderr()) {
        if (statusCode) {
          process.stderr.write(
            `[MCP Proxy] ✗ Connection failed: ${errorMessage} (HTTP ${statusCode})\n`,
          );
        } else {
          process.stderr.write(
            `[MCP Proxy] ✗ Connection failed: ${errorMessage}\n`,
          );
        }
      }

      return createErrorResponse(
        originalRequest.id || null,
        statusCode || -32000,
        errorMessage,
        {
          circuitBreakerState: this.circuitBreaker.getState(),
          originalError:
            axios.isAxiosError(error) && error.response?.data
              ? error.response.data
              : undefined,
        },
      );
    }
  }
}

/**
 * Create Cloud LLM Hub Proxy instance
 */
export async function createCloudLlmHubProxy(
  config?: Partial<ProxyConfig>,
): Promise<CloudLlmHubProxy> {
  const unsafe = config?.unsafe ?? false;

  // Get stores for BTP destinations
  const { serviceKeyStore: btpServiceKeyStore, sessionStore: btpSessionStore } =
    await getPlatformStores(unsafe);

  // Create BTP auth broker with ClientCredentialsProvider (for BTP/XSUAA destinations)
  const btpTokenProvider = new ClientCredentialsProvider({
    uaaUrl: 'https://placeholder.authentication.sap.hana.ondemand.com',
    clientId: 'placeholder',
    clientSecret: 'placeholder',
  });
  const btpAuthBroker = new AuthBroker(
    {
      serviceKeyStore: btpServiceKeyStore,
      sessionStore: btpSessionStore,
      tokenProvider: btpTokenProvider,
    },
    'none',
    loggerAdapter,
  );

  return new CloudLlmHubProxy(btpAuthBroker, config);
}

/**
 * Cloud LLM Hub Proxy - Proxies requests to cloud-llm-hub with JWT authentication
 *
 * For requests with x-sap-destination: "sk", proxies to cloud-llm-hub
 * with JWT token from auth-broker
 */

import { AuthBroker, type ILogger } from '@mcp-abap-adt/auth-broker';
import {
  AuthorizationCodeProvider,
  ClientCredentialsProvider,
} from '@mcp-abap-adt/auth-providers';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces';
import {
  AUTH_TYPE_JWT,
  HEADER_ACCEPT,
  HEADER_AUTHORIZATION,
  HEADER_BTP_DESTINATION,
  HEADER_CONTENT_TYPE,
  HEADER_MCP_DESTINATION,
  HEADER_MCP_URL,
  HEADER_SAP_AUTH_TYPE,
  HEADER_SAP_CLIENT,
  HEADER_SAP_DESTINATION_SERVICE,
  HEADER_SAP_JWT_TOKEN,
  HEADER_SAP_URL,
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
    typeof (globalThis as any).jest !== 'undefined';
  return verboseMode && !isTestEnv;
}

export interface ProxyRequest {
  method: string;
  params?: any;
  id?: string | number | null;
  jsonrpc?: string;
}

export interface ProxyResponse {
  jsonrpc: string;
  id?: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * Cloud LLM Hub Proxy Client
 */
export class CloudLlmHubProxy {
  private axiosInstance: AxiosInstance;
  private defaultBtpAuthBroker: AuthBroker; // Default BTP broker (for requests without x-btp-destination)
  private defaultAbapAuthBroker: AuthBroker; // Default ABAP broker (for requests without x-mcp-destination)
  private btpAuthBrokers: Map<string, AuthBroker> = new Map(); // Dynamic map of BTP brokers by destination
  private abapAuthBrokers: Map<string, AuthBroker> = new Map(); // Dynamic map of ABAP brokers by destination
  private tokenCache: Map<string, { token: string; expiresAt: number }> =
    new Map();
  private readonly TOKEN_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  private circuitBreaker: CircuitBreaker;
  private config: ProxyConfig;
  private unsafe: boolean;

  constructor(
    defaultBtpAuthBroker: AuthBroker,
    defaultAbapAuthBroker: AuthBroker,
    config?: Partial<ProxyConfig>,
  ) {
    this.defaultBtpAuthBroker = defaultBtpAuthBroker;
    this.defaultAbapAuthBroker = defaultAbapAuthBroker;
    this.unsafe = config?.unsafe ?? false;

    // Use provided config if available (from YAML or CLI/ENV, already loaded in index.ts)
    // If no config provided, load from CLI/ENV as fallback
    if (config) {
      // Config is already loaded from YAML (if --config) or CLI/ENV (if no --config)
      // No merging - use config as-is (mutually exclusive: either YAML or CLI/ENV)
      this.config = config as ProxyConfig;
      logger?.debug('Using provided config in CloudLlmHubProxy constructor', {
        type: 'CONFIG_PROVIDED',
        browserAuthPort: this.config.browserAuthPort,
        hasBrowserAuthPort: this.config.browserAuthPort !== undefined,
        browserAuthPortType: typeof this.config.browserAuthPort,
        mcpDestination: this.config.mcpDestination,
        btpDestination: this.config.btpDestination,
        configKeys: Object.keys(this.config),
        fullConfig: JSON.stringify(this.config, null, 2),
      });
    } else {
      // Fallback: load from CLI/ENV (should not happen if called from index.ts)
      this.config = loadConfig();
      logger?.info(
        'Using fallback config from CLI/ENV in CloudLlmHubProxy constructor',
        {
          type: 'CONFIG_FALLBACK',
          browserAuthPort: this.config.browserAuthPort,
          hasBrowserAuthPort: this.config.browserAuthPort !== undefined,
        },
      );
    }

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold || 5,
      this.config.circuitBreakerTimeout || 60000,
    );

    // Create axios instance without baseURL - we'll use full URLs from x-mcp-url
    // Configure HTTPS agent for proper SSL/TLS handling
    const https = require('node:https');
    this.axiosInstance = axios.create({
      timeout: this.config.requestTimeout || 60000,
      headers: {
        [HEADER_CONTENT_TYPE]: 'application/json',
      },
      httpsAgent: new https.Agent({
        // Allow self-signed certificates if needed (for development)
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
        // Keep connections alive for better performance
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
      true,
    );

    // Create token provider BEFORE creating session
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
    // If config is not available, create placeholder (will fail gracefully)
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
    // This ensures session exists before AuthBroker tries to update it
    // Validator requires non-empty authorizationToken or jwtToken, so we use placeholder
    try {
      const authConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      const connConfig = await serviceKeyStore.getConnectionConfig(destination);

      if (authConfig) {
        // For XSUAA: create session with authConfig and placeholder token
        const sessionData: any = {
          ...authConfig,
          jwtToken: 'placeholder', // Placeholder to pass validation, will be replaced by AuthBroker
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
      // If service key doesn't exist or can't be read, continue without initial session
      // AuthBroker will handle this case
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
   * Get or create ABAP auth broker for specific destination
   * If destination is not provided, returns default broker
   * If broker doesn't exist in map, creates new one and stores it
   */
  private async getOrCreateAbapAuthBroker(
    destination?: string,
  ): Promise<AuthBroker> {
    // If no destination, use default broker
    if (!destination) {
      return this.defaultAbapAuthBroker;
    }

    // Check if broker exists in map
    let broker = this.abapAuthBrokers.get(destination);
    if (broker) {
      return broker;
    }

    // Create new broker for this destination
    logger?.info('Creating new ABAP auth broker for destination', {
      type: 'ABAP_BROKER_CREATE',
      destination,
    });

    const { serviceKeyStore, sessionStore } = await getPlatformStores(
      this.unsafe,
      false,
    );

    // Create token provider BEFORE creating session
    // Load auth config from service key store to create provider with correct config
    let authConfig: IAuthorizationConfig | null = null;
    try {
      authConfig = await serviceKeyStore.getAuthorizationConfig(destination);
    } catch (error) {
      logger?.debug('Could not load auth config for ABAP provider', {
        destination,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Use browserAuthPort from config if available, otherwise default to 3001
    const browserAuthPort = this.config.browserAuthPort ?? 3001;
    logger?.debug('Creating AuthorizationCodeProvider with browserAuthPort', {
      type: 'AUTHORIZATION_CODE_PROVIDER_CREATE',
      destination,
      browserAuthPort,
      hasBrowserAuthPort: this.config.browserAuthPort !== undefined,
      configBrowserAuthPort: this.config.browserAuthPort,
      configKeys: Object.keys(this.config),
    });

    // Create AuthorizationCodeProvider with config from service key store
    // If config is not available, create placeholder (will fail gracefully)
    const btpTokenProvider = authConfig
      ? new AuthorizationCodeProvider({
          uaaUrl: authConfig.uaaUrl,
          clientId: authConfig.uaaClientId,
          clientSecret: authConfig.uaaClientSecret,
          browser: 'system',
          redirectPort: browserAuthPort,
        })
      : new AuthorizationCodeProvider({
          uaaUrl: 'https://placeholder.authentication.sap.hana.ondemand.com',
          clientId: 'placeholder',
          clientSecret: 'placeholder',
          browser: 'system',
          redirectPort: browserAuthPort,
        });

    // Create initial session using data from service key (if available)
    // This ensures session exists before AuthBroker tries to update it
    // Validator requires non-empty authorizationToken or jwtToken and serviceUrl, so we use placeholder
    try {
      const authConfig =
        await serviceKeyStore.getAuthorizationConfig(destination);
      const connConfig = await serviceKeyStore.getConnectionConfig(destination);

      if (authConfig && connConfig && connConfig.serviceUrl) {
        // For ABAP: create session with serviceUrl and placeholder token
        const sessionData: any = {
          ...authConfig,
          serviceUrl: connConfig.serviceUrl,
          jwtToken: 'placeholder', // Placeholder to pass validation, will be replaced by AuthBroker
          sapClient: connConfig.sapClient,
          language: connConfig.language,
        };

        await sessionStore.saveSession(destination, sessionData);
        logger?.debug('Created initial session for ABAP destination', {
          type: 'ABAP_SESSION_CREATED',
          destination,
          hasAuthConfig: !!authConfig,
          hasConnConfig: !!connConfig,
        });
      }
    } catch (error) {
      // If service key doesn't exist or can't be read, continue without initial session
      // AuthBroker will handle this case
      logger?.debug(
        'Could not create initial session for ABAP destination (service key may not exist)',
        {
          type: 'ABAP_SESSION_CREATE_SKIPPED',
          destination,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    broker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider: btpTokenProvider,
      },
      'system',
      loggerAdapter,
    );

    // Store in map for future use
    this.abapAuthBrokers.set(destination, broker);
    return broker;
  }

  /**
   * Get JWT token for destination from auth-broker with retry and token refresh
   * @param destination Destination name
   * @param isBtpDestination If true, use BTP auth broker (XsuaaTokenProvider), otherwise use ABAP auth broker (BtpTokenProvider)
   * @param forceRefresh Force token refresh
   */
  private async getJwtToken(
    destination: string,
    isBtpDestination: boolean = false,
    forceRefresh: boolean = false,
  ): Promise<string> {
    // Log which broker we're using
    logger?.info('Getting JWT token', {
      type: 'JWT_TOKEN_GET_START',
      destination,
      isBtpDestination,
      brokerType: isBtpDestination
        ? 'BTP (XsuaaTokenProvider)'
        : 'ABAP (BtpTokenProvider)',
    });

    // Get or create appropriate auth broker for this destination
    const authBroker = isBtpDestination
      ? await this.getOrCreateBtpAuthBroker(destination)
      : await this.getOrCreateAbapAuthBroker(destination);

    // For ABAP destinations, log browser auth port if available
    if (!isBtpDestination) {
      logger?.debug('ABAP token retrieval - browser auth may be triggered', {
        type: 'ABAP_TOKEN_RETRIEVAL',
        destination,
        browserAuthPort: this.config.browserAuthPort ?? 3001,
        hasBrowserAuthPort: this.config.browserAuthPort !== undefined,
      });
    }

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

        // Log which broker and provider we're using
        logger?.debug('Getting JWT token from auth-broker', {
          type: 'JWT_TOKEN_REQUEST_START',
          destination,
          isBtpDestination,
          forceRefresh,
        });

        // For debugging: check if service key exists and can be read
        if (isBtpDestination) {
          try {
            // Note: serviceKeyStore and tokenProvider are private in AuthBroker
            // We can't access them directly, so we skip this debug check
            // The AuthBroker will handle service key loading internally

            // Check parser type
            // Note: serviceKeyStore and tokenProvider are private in AuthBroker
            // We can't access them directly for debugging, so we skip this detailed check
            // The AuthBroker will handle service key loading internally
            logger?.info('BTP service key check skipped (private properties)', {
              type: 'BTP_SERVICE_KEY_CHECK_SKIPPED',
              destination,
            });
          } catch (error) {
            logger?.warn('Failed to check BTP service key', {
              type: 'BTP_SERVICE_KEY_CHECK_ERROR',
              destination,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
          }
        }

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
          isBtpDestination,
          forceRefresh,
        });

        return token;
      }, retryOptions);

      return token;
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : String(error);

      // Rewrite error message to remove .env file references (proxy only uses service keys)
      if (errorMessage.includes('.env') || errorMessage.includes('mcp.env')) {
        // Extract searched paths from error message if present
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

        // Create proxy-specific error message
        errorMessage =
          `Service key file not found for destination "${destination}".\n` +
          `Please create service key file: ${destination}.json\n`;

        if (searchedPaths.length > 0) {
          errorMessage += `Searched in:\n`;
          searchedPaths.forEach((path) => {
            errorMessage += `  - ${path}\n`;
          });
        } else {
          // Fallback: use default paths
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
      // Output error to stderr for user visibility (only if verbose mode is enabled)
      if (shouldWriteStderr()) {
        process.stderr.write(`[MCP Proxy] ✗ ${errorMessage}`);
      }

      // Throw new error with rewritten message
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
   * Build proxy request with JWT tokens and SAP configuration
   *
   * Process flow:
   *
   * 1. XSUAA BLOCK (BTP Authentication):
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
   *        - Add/replace x-sap-jwt-token header (preserve if exists)
   *
   * 2. ABAP BLOCK (SAP ABAP Authentication):
   *    2.1 If x-mcp-destination header exists:
   *        - Find broker in map, create if not found, save to map
   *        - Get token from broker
   *        - Add/replace x-sap-jwt-token header
   *    2.2 If header doesn't exist but --mcp parameter exists:
   *        - Use default broker
   *        - Get token from broker
   *        - Add/replace x-sap-jwt-token header
   *    2.3 If neither header nor parameter:
   *        - Don't modify request, just translate to mcp_url
   */
  private async buildProxyRequest(
    originalRequest: ProxyRequest,
    routingDecision: RoutingDecision,
    originalHeaders: Record<string, string | string[] | undefined>,
    forceTokenRefresh: boolean = false,
  ): Promise<AxiosRequestConfig> {
    // Log original request to verify id is preserved
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
    // STEP 1: XSUAA BLOCK - BTP Authentication
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
      // 1.1: Header exists - use it
      btpDestination = btpDestinationHeader;
      logger?.debug('Using x-btp-destination from header', {
        type: 'BTP_DESTINATION_FROM_HEADER',
        destination: btpDestination,
      });
    } else if (btpDestinationFromParam) {
      // 1.2: Header doesn't exist but parameter exists - use parameter
      btpDestination = btpDestinationFromParam;
      logger?.debug('Using x-btp-destination from parameter', {
        type: 'BTP_DESTINATION_FROM_PARAM',
        destination: btpDestination,
      });
    }
    // 1.3: Neither header nor parameter - do nothing (will handle x-sap-jwt-token later)

    if (btpDestination) {
      // Get or create broker for this destination (check map first, create if needed, save to map)
      const _btpBroker = await this.getOrCreateBtpAuthBroker(btpDestination);

      // Check if Authorization header already exists in original request
      const existingAuth =
        originalHeaders[HEADER_AUTHORIZATION.toLowerCase()] ||
        originalHeaders[HEADER_AUTHORIZATION];
      const hasExistingAuth = !!existingAuth;

      // Get token from xsuaa broker
      const authToken = await this.getJwtToken(
        btpDestination,
        true,
        forceTokenRefresh,
      );

      // Add/replace Authorization header
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
      // 1.3: No BTP destination - preserve/add x-sap-jwt-token if it exists in original request
      const existingSapJwtToken = this.getHeaderValue(
        originalHeaders[HEADER_SAP_JWT_TOKEN],
      );
      if (existingSapJwtToken) {
        proxyHeaders[HEADER_SAP_JWT_TOKEN] = existingSapJwtToken;
        logger?.debug(
          'Preserved x-sap-jwt-token from original request (no BTP destination)',
          {
            type: 'SAP_JWT_TOKEN_PRESERVED',
          },
        );
      } else {
        logger?.debug('No BTP destination and no x-sap-jwt-token in request', {
          type: 'BTP_AUTH_SKIPPED',
        });
      }
    }

    // ============================================
    // STEP 2: ABAP BLOCK - SAP ABAP Authentication
    // ============================================
    const mcpDestinationHeader = this.getHeaderValue(
      originalHeaders[HEADER_MCP_DESTINATION],
    );
    const mcpDestinationFromParam =
      routingDecision.mcpDestination && !mcpDestinationHeader
        ? routingDecision.mcpDestination
        : undefined;

    let mcpDestination: string | undefined;
    if (mcpDestinationHeader) {
      // 2.1: Header exists - find broker in map, create if not found, save to map
      mcpDestination = mcpDestinationHeader;
      logger?.debug('Using x-mcp-destination from header', {
        type: 'MCP_DESTINATION_FROM_HEADER',
        destination: mcpDestination,
      });

      // Get or create broker for this destination
      const abapBroker = await this.getOrCreateAbapAuthBroker(mcpDestination);
      const connConfig = await abapBroker.getConnectionConfig(mcpDestination);
      const sapUrl = connConfig?.serviceUrl;

      // Get token from broker
      try {
        const sapToken = await this.getJwtToken(
          mcpDestination,
          false,
          forceTokenRefresh,
        );
        // Add/replace x-sap-jwt-token header
        proxyHeaders[HEADER_SAP_JWT_TOKEN] = sapToken;

        logger?.debug('Added/replaced x-sap-jwt-token from ABAP broker', {
          type: 'SAP_TOKEN_ADDED_FROM_BROKER',
          destination: mcpDestination,
          tokenLength: sapToken?.length || 0,
          hasToken: !!sapToken,
        });
      } catch (error) {
        logger?.error(
          'Failed to get SAP ABAP token (continuing without token)',
          {
            type: 'SAP_TOKEN_SKIPPED',
            destination: mcpDestination,
            error: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
          },
        );
      }

      // Add SAP ABAP headers (x-sap-url and x-sap-auth-type are always added by ABAP broker)
      // Note: x-sap-destination is NOT added by proxy (only client can add it)
      if (sapUrl !== undefined && sapUrl !== null) {
        proxyHeaders[HEADER_SAP_URL] = sapUrl;
      }
      proxyHeaders[HEADER_SAP_AUTH_TYPE] = AUTH_TYPE_JWT;
    } else if (mcpDestinationFromParam) {
      // 2.2: Header doesn't exist but --mcp parameter exists - use default broker
      mcpDestination = mcpDestinationFromParam;
      logger?.debug('Using x-mcp-destination from parameter (default broker)', {
        type: 'MCP_DESTINATION_FROM_PARAM',
        destination: mcpDestination,
      });

      // Use default broker directly (don't create new broker)
      const abapBroker = this.defaultAbapAuthBroker;
      const connConfig = await abapBroker.getConnectionConfig(mcpDestination);
      const sapUrl = connConfig?.serviceUrl;

      // Get token from default broker directly
      try {
        // Check cache first (unless force refresh)
        let sapToken: string;
        if (!forceTokenRefresh) {
          const cached = this.tokenCache.get(mcpDestination);
          if (cached && cached.expiresAt > Date.now()) {
            sapToken = cached.token;
            logger?.debug('Using cached token from default broker', {
              type: 'SAP_TOKEN_CACHE_HIT_DEFAULT',
              destination: mcpDestination,
            });
          } else {
            sapToken = await abapBroker.getToken(mcpDestination);
            // Cache token
            this.tokenCache.set(mcpDestination, {
              token: sapToken,
              expiresAt: Date.now() + this.TOKEN_CACHE_TTL,
            });
          }
        } else {
          this.tokenCache.delete(mcpDestination);
          sapToken = await abapBroker.getToken(mcpDestination);
          // Cache token
          this.tokenCache.set(mcpDestination, {
            token: sapToken,
            expiresAt: Date.now() + this.TOKEN_CACHE_TTL,
          });
        }

        // Add/replace x-sap-jwt-token header
        proxyHeaders[HEADER_SAP_JWT_TOKEN] = sapToken;

        logger?.debug(
          'Added/replaced x-sap-jwt-token from default ABAP broker',
          {
            type: 'SAP_TOKEN_ADDED_FROM_DEFAULT_BROKER',
            destination: mcpDestination,
          },
        );
      } catch (error) {
        logger?.warn(
          'Failed to get SAP ABAP token from default broker (continuing without token)',
          {
            type: 'SAP_TOKEN_SKIPPED_DEFAULT',
            destination: mcpDestination,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }

      // Add SAP ABAP headers (x-sap-url and x-sap-auth-type are always added by ABAP broker)
      // Note: x-sap-destination is NOT added by proxy (only client can add it)
      if (sapUrl !== undefined && sapUrl !== null) {
        proxyHeaders[HEADER_SAP_URL] = sapUrl;
      }
      proxyHeaders[HEADER_SAP_AUTH_TYPE] = AUTH_TYPE_JWT;
    } else {
      // 2.3: Neither header nor parameter - don't modify request, just translate to mcp_url
      logger?.debug(
        'No x-mcp-destination header or parameter - will translate to mcp_url only',
        {
          type: 'MCP_DESTINATION_SKIPPED',
        },
      );
    }

    // Preserve other original SAP headers if provided
    // Note: x-sap-destination is NOT added by proxy (only client can add it), but we preserve it if present
    // Note: x-sap-auth-type is only preserved if not already set by ABAP block above
    const sapHeaders = [
      HEADER_SAP_CLIENT,
      HEADER_SAP_DESTINATION_SERVICE, // Preserve if client provides it (for SAP destination service on Cloud)
    ];

    for (const headerName of sapHeaders) {
      const value = originalHeaders[headerName];
      if (value) {
        proxyHeaders[headerName] = Array.isArray(value) ? value[0] : value;
      }
    }

    // Preserve x-sap-auth-type only if not already set by ABAP block
    // (ABAP block sets it to "jwt" when x-mcp-destination is present)
    if (!proxyHeaders[HEADER_SAP_AUTH_TYPE]) {
      const sapAuthType = this.getHeaderValue(
        originalHeaders[HEADER_SAP_AUTH_TYPE],
      );
      if (sapAuthType) {
        proxyHeaders[HEADER_SAP_AUTH_TYPE] = sapAuthType;
      }
    }

    // Get MCP server URL with priority:
    // 1. x-mcp-url header or --mcp-url parameter (explicit URL - highest priority)
    // 2. BTP destination service key (if btpDestination is present)
    // 3. MCP destination service key (if mcpDestination is present)
    let baseUrl: string | undefined;

    const mcpUrlHeader = this.getHeaderValue(originalHeaders[HEADER_MCP_URL]);
    const mcpUrlFromParam =
      routingDecision.mcpUrl && !mcpUrlHeader
        ? routingDecision.mcpUrl
        : undefined;

    if (mcpUrlHeader || mcpUrlFromParam) {
      // Priority 1: Use direct URL from x-mcp-url header or --mcp-url parameter
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
      // Priority 2: Get URL from BTP destination service key
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
    } else if (mcpDestination) {
      // Priority 3: Get URL from MCP destination service key
      try {
        const abapBroker = mcpDestinationHeader
          ? await this.getOrCreateAbapAuthBroker(mcpDestination)
          : this.defaultAbapAuthBroker;
        const connConfig = await abapBroker.getConnectionConfig(mcpDestination);
        baseUrl = connConfig?.serviceUrl;
        if (baseUrl) {
          logger?.debug('Using MCP URL from MCP destination service key', {
            type: 'MCP_URL_FROM_MCP_DESTINATION',
            destination: mcpDestination,
            url: baseUrl,
          });
        } else {
          logger?.warn(
            'MCP destination service key does not contain service URL',
            {
              type: 'MCP_DESTINATION_NO_URL',
              destination: mcpDestination,
            },
          );
        }
      } catch (error) {
        logger?.warn('Failed to get URL from MCP destination service key', {
          type: 'MCP_DESTINATION_URL_ERROR',
          destination: mcpDestination,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!baseUrl) {
      throw new Error(
        'Cannot determine MCP server URL: provide x-mcp-url/--mcp-url, or use btpDestination/mcpDestination with service key containing URL',
      );
    }

    // Construct full MCP endpoint URL
    // If baseUrl already contains the path, use it as-is
    // Otherwise, append default endpoint /mcp/stream/http
    let fullUrl: string;
    // Check if URL already contains MCP path (more flexible check)
    if (
      baseUrl.includes('/mcp/') ||
      baseUrl.endsWith('/mcp') ||
      baseUrl.includes('/mcp/stream/')
    ) {
      // URL already contains MCP path - use as-is (but remove trailing slash if present)
      fullUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
      logger?.debug('Using MCP URL as-is (already contains path)', {
        type: 'MCP_URL_AS_IS',
        original: baseUrl,
        final: fullUrl,
      });
    } else {
      // Append default endpoint
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

    const sanitizedRequestParams: any = {};
    if (originalRequest.params && typeof originalRequest.params === 'object') {
      if (
        originalRequest.params.arguments &&
        typeof originalRequest.params.arguments === 'object'
      ) {
        sanitizedRequestParams.arguments = {};
        for (const [key, value] of Object.entries(
          originalRequest.params.arguments,
        )) {
          const lowerKey = key.toLowerCase();
          if (
            lowerKey.includes('password') ||
            lowerKey.includes('token') ||
            lowerKey.includes('secret')
          ) {
            sanitizedRequestParams.arguments[key] = '[REDACTED]';
          } else {
            sanitizedRequestParams.arguments[key] = value;
          }
        }
      }
      for (const [key, value] of Object.entries(originalRequest.params)) {
        if (key === 'arguments') continue;
        sanitizedRequestParams[key] = value;
      }
    }

    logger?.info('=== BUILDING PROXY REQUEST ===', {
      type: 'PROXY_REQUEST_BUILT',
      btpDestination: btpDestination,
      mcpDestination: mcpDestination,
      url: fullUrl,
      headers: builtHeaders,
      mcpUrl: mcpUrlHeader || mcpUrlFromParam,
      baseUrl,
      fullUrl,
      hasAuthToken: !!proxyHeaders[HEADER_AUTHORIZATION],
      hasSapJwtToken: !!proxyHeaders[HEADER_SAP_JWT_TOKEN],
      sapHeaders: Object.keys(proxyHeaders).filter((h) =>
        h.startsWith('x-sap'),
      ),
      btpSource: btpDestinationHeader
        ? 'header'
        : btpDestinationFromParam
          ? 'parameter'
          : 'none',
      mcpSource: mcpDestinationHeader
        ? 'header'
        : mcpDestinationFromParam
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
        mcpDestination: routingDecision.mcpDestination,
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
        // Check for token expiration and refresh if needed
        const forceTokenRefresh = false;

        // Build proxy request (will get fresh token if needed)
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

        const sanitizedOutgoingBody: any = {};
        if (proxyConfig.data && typeof proxyConfig.data === 'object') {
          if (
            proxyConfig.data.params &&
            typeof proxyConfig.data.params === 'object'
          ) {
            sanitizedOutgoingBody.params = {};
            // For tools/call, log arguments
            if (
              proxyConfig.data.params.arguments &&
              typeof proxyConfig.data.params.arguments === 'object'
            ) {
              sanitizedOutgoingBody.params.arguments = {};
              for (const [key, value] of Object.entries(
                proxyConfig.data.params.arguments,
              )) {
                const lowerKey = key.toLowerCase();
                if (
                  lowerKey.includes('password') ||
                  lowerKey.includes('token') ||
                  lowerKey.includes('secret')
                ) {
                  sanitizedOutgoingBody.params.arguments[key] = '[REDACTED]';
                } else {
                  sanitizedOutgoingBody.params.arguments[key] = value;
                }
              }
            }
            // Log other params
            for (const [key, value] of Object.entries(
              proxyConfig.data.params,
            )) {
              if (key === 'arguments') continue;
              sanitizedOutgoingBody.params[key] = value;
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
        const sanitizedResponse: any = {
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

      // Log detailed error information (always log errors, but detailed info only in debug mode)
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as any;
        logger?.error('Request failed', {
          type: 'PROXY_REQUEST_FAILED',
          status: axiosError.response?.status,
          statusText: axiosError.response?.statusText,
          url: axiosError.config?.url,
        });
        // Detailed error info only in debug mode
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
          mcpDestination: routingDecision.mcpDestination,
        });

        // Retry once with fresh token
        try {
          const proxyConfig = await this.buildProxyRequest(
            originalRequest,
            routingDecision,
            originalHeaders,
            true, // Force token refresh
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

      // Output error to stderr for user visibility (only if verbose mode is enabled)
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

      // Return error response in MCP format
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
  cloudLlmHubUrl: string,
  config?: Partial<ProxyConfig>,
): Promise<CloudLlmHubProxy> {
  const unsafe = config?.unsafe ?? false;

  // Get stores for BTP destinations (prefer XSUAA store)
  const { serviceKeyStore: btpServiceKeyStore, sessionStore: btpSessionStore } =
    await getPlatformStores(unsafe, true);

  // Get stores for ABAP destinations (prefer ABAP store)
  const {
    serviceKeyStore: abapServiceKeyStore,
    sessionStore: abapSessionStore,
  } = await getPlatformStores(unsafe, false);

  // Create BTP auth broker with ClientCredentialsProvider (for BTP/XSUAA destinations)
  // Use 'none' browser parameter because XSUAA uses client_credentials (no browser needed)
  // Note: Provider will be created dynamically per destination when needed
  // For default broker, we create a placeholder provider that will fail gracefully
  // until a destination-specific broker is created
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
    'none', // XSUAA doesn't need browser (uses client_credentials)
    loggerAdapter, // Pass logger adapter to AuthBroker for debugging
  );

  // Create ABAP auth broker with AuthorizationCodeProvider (for ABAP destinations)
  // Use browserAuthPort from config if available, otherwise default to 3001
  // Note: Provider will be created dynamically per destination when needed
  // For default broker, we create a placeholder provider that will fail gracefully
  // until a destination-specific broker is created
  const browserAuthPort = config?.browserAuthPort ?? 3001;
  logger?.debug(
    'Creating AuthorizationCodeProvider in createCloudLlmHubProxy with browserAuthPort',
    {
      type: 'AUTHORIZATION_CODE_PROVIDER_CREATE_DEFAULT',
      browserAuthPort,
      hasBrowserAuthPort: config?.browserAuthPort !== undefined,
      configBrowserAuthPort: config?.browserAuthPort,
      configKeys: config ? Object.keys(config) : [],
    },
  );
  const abapTokenProvider = new AuthorizationCodeProvider({
    uaaUrl: 'https://placeholder.authentication.sap.hana.ondemand.com',
    clientId: 'placeholder',
    clientSecret: 'placeholder',
    browser: 'system',
    redirectPort: browserAuthPort,
  });
  const abapAuthBroker = new AuthBroker(
    {
      serviceKeyStore: abapServiceKeyStore,
      sessionStore: abapSessionStore,
      tokenProvider: abapTokenProvider,
    },
    'system',
    loggerAdapter, // Pass logger adapter to AuthBroker for debugging
  );

  return new CloudLlmHubProxy(btpAuthBroker, abapAuthBroker, config);
}

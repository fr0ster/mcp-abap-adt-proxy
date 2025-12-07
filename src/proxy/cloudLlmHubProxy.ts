/**
 * Cloud LLM Hub Proxy - Proxies requests to cloud-llm-hub with JWT authentication
 * 
 * For requests with x-sap-destination: "sk", proxies to cloud-llm-hub
 * with JWT token from auth-broker
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from "axios";
import { AuthBroker } from "@mcp-abap-adt/auth-broker";
import { BtpTokenProvider, XsuaaTokenProvider } from "@mcp-abap-adt/auth-providers";
import { logger } from "../lib/logger.js";
import { RoutingDecision } from "../router/headerAnalyzer.js";
import { loadConfig, ProxyConfig } from "../lib/config.js";
import { getPlatformStores } from "../lib/stores.js";
import {
  retryWithBackoff,
  CircuitBreaker,
  isTokenExpirationError,
  createErrorResponse,
  RetryOptions,
} from "../lib/errorHandler.js";

/**
 * Check if error messages should be written to stderr
 * Only output in verbose mode and not in test environment
 */
export function shouldWriteStderr(): boolean {
  const verboseMode = process.env.MCP_PROXY_VERBOSE === "true" || 
                     process.env.DEBUG === "true" || 
                     process.env.DEBUG?.includes("mcp-proxy") === true;
  const isTestEnv = process.env.NODE_ENV === "test" || 
                   process.env.JEST_WORKER_ID !== undefined ||
                   typeof (globalThis as any).jest !== "undefined";
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
  private btpAuthBroker: AuthBroker; // For BTP destinations (uses XsuaaTokenProvider)
  private abapAuthBroker: AuthBroker; // For ABAP destinations (uses BtpTokenProvider)
  private defaultBaseUrl: string;
  private tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
  private readonly TOKEN_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  private circuitBreaker: CircuitBreaker;
  private config: ProxyConfig;

  constructor(
    defaultBaseUrl: string, 
    btpAuthBroker: AuthBroker,
    abapAuthBroker: AuthBroker,
    config?: Partial<ProxyConfig>
  ) {
    // Default base URL (used if x-mcp-url is relative)
    this.defaultBaseUrl = defaultBaseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.btpAuthBroker = btpAuthBroker;
    this.abapAuthBroker = abapAuthBroker;
    this.config = loadConfig();
    
    // Merge provided config
    if (config) {
      this.config = { ...this.config, ...config };
    }

    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold || 5,
      this.config.circuitBreakerTimeout || 60000
    );

    // Create axios instance without baseURL - we'll use full URLs from x-mcp-url
    // Configure HTTPS agent for proper SSL/TLS handling
    const https = require('https');
    this.axiosInstance = axios.create({
      timeout: this.config.requestTimeout || 60000,
      headers: {
        "Content-Type": "application/json",
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
        logger.debug("Proxying request to cloud-llm-hub", {
          type: "CLOUD_LLM_HUB_PROXY_REQUEST",
          method: config.method,
          url: config.url,
          baseURL: config.baseURL,
        });
        return config;
      },
      (error) => {
        logger.error("Request interceptor error", {
          type: "CLOUD_LLM_HUB_PROXY_REQUEST_ERROR",
          error: error instanceof Error ? error.message : String(error),
        });
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    this.axiosInstance.interceptors.response.use(
      (response) => {
        logger.debug("Received response from cloud-llm-hub", {
          type: "CLOUD_LLM_HUB_PROXY_RESPONSE",
          status: response.status,
          url: response.config.url,
        });
        return response;
      },
      (error) => {
        logger.error("Response interceptor error", {
          type: "CLOUD_LLM_HUB_PROXY_RESPONSE_ERROR",
          error: error instanceof Error ? error.message : String(error),
          status: error.response?.status,
          url: error.config?.url,
        });
        return Promise.reject(error);
      }
    );
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
    forceRefresh: boolean = false
  ): Promise<string> {
    // Select appropriate auth broker based on destination type
    const authBroker = isBtpDestination ? this.btpAuthBroker : this.abapAuthBroker;
    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = this.tokenCache.get(destination);
      if (cached && cached.expiresAt > Date.now()) {
        logger.debug("Using cached JWT token", {
          type: "JWT_TOKEN_CACHE_HIT",
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

        // Get token from auth-broker
        const token = await authBroker.getToken(destination);
        
        // Cache token (assume it's valid for 30 minutes)
        this.tokenCache.set(destination, {
          token,
          expiresAt: Date.now() + this.TOKEN_CACHE_TTL,
        });

        logger.debug("Retrieved JWT token from auth-broker", {
          type: "JWT_TOKEN_RETRIEVED",
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
        // Extract searched paths from error message if present
        const searchedInMatch = errorMessage.match(/Searched in:\s*([\s\S]*?)(?:\n|$)/);
        const searchedPaths = searchedInMatch ? searchedInMatch[1].trim().split('\n').map(p => p.trim().replace(/^-\s*/, '')).filter(p => p) : [];
        
        // Create proxy-specific error message
        errorMessage = `Service key file not found for destination "${destination}".\n` +
          `Please create service key file: ${destination}.json\n`;
        
        if (searchedPaths.length > 0) {
          errorMessage += `Searched in:\n`;
          searchedPaths.forEach(path => {
            errorMessage += `  - ${path}\n`;
          });
        } else {
          // Fallback: use default paths
          const isWindows = process.platform === 'win32';
          const homeDir = require('os').homedir();
          const defaultPath = isWindows
            ? require('path').join(homeDir, 'Documents', 'mcp-abap-adt', 'service-keys')
            : require('path').join(homeDir, '.config', 'mcp-abap-adt', 'service-keys');
          errorMessage += `Searched in:\n  - ${defaultPath}\n`;
        }
      }
      
      logger.error("Failed to get JWT token from auth-broker after retries", {
        type: "JWT_TOKEN_ERROR",
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
   * Build proxy request with JWT tokens and SAP configuration
   * 
   * Process flow:
   * 1. XSUAA block: If --btp or x-btp-destination is present
   *    - Uses btpAuthBroker (with XsuaaTokenProvider)
   *    - Injects/overwrites Authorization: Bearer <token> header
   * 
   * 2. ABAP block: If --mcp or x-mcp-destination is present
   *    - Uses abapAuthBroker (with BtpTokenProvider)
   *    - Injects/overwrites x-sap-jwt-token: <token> header
   *    - Adds x-sap-url and other SAP configuration headers
   * 
   * 3. Other headers: Preserves other SAP headers from original request
   * 
   * Uses service keys:
   * - x-btp-destination - for BTP Cloud authorization (Authorization: Bearer token) - OPTIONAL
   * - x-mcp-destination - for SAP ABAP connection (SAP headers with token and config) - OPTIONAL
   * 
   * Can work with only x-mcp-destination (without BTP) for local testing without authentication
   */
  private async buildProxyRequest(
    originalRequest: ProxyRequest,
    routingDecision: RoutingDecision,
    originalHeaders: Record<string, string | string[] | undefined>,
    forceTokenRefresh: boolean = false
  ): Promise<AxiosRequestConfig> {
    // Build headers for target MCP server
    const proxyHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // ============================================
    // XSUAA BLOCK: BTP Authentication
    // ============================================
    // If --btp parameter or x-btp-destination header is present:
    // - Use btpAuthBroker (with XsuaaTokenProvider)
    // - Check if Authorization header exists in original request
    // - Replace existing Authorization header or add new one
    if (routingDecision.btpDestination) {
      // Check if Authorization header already exists in original request
      const existingAuth = originalHeaders["authorization"] || originalHeaders["Authorization"];
      const hasExistingAuth = !!existingAuth;
      
      // For BTP destinations, use XsuaaTokenProvider (client_credentials)
      const authToken = await this.getJwtToken(routingDecision.btpDestination, true, forceTokenRefresh);
      
      // Replace existing Authorization header or add new one
      proxyHeaders["Authorization"] = `Bearer ${authToken}`;
      
      logger.debug(hasExistingAuth ? "Replaced existing Authorization header with BTP token" : "Added BTP Cloud authorization token", {
        type: hasExistingAuth ? "BTP_AUTH_TOKEN_REPLACED" : "BTP_AUTH_TOKEN_ADDED",
        destination: routingDecision.btpDestination,
        hadExistingAuth: hasExistingAuth,
      });
    } else {
      logger.debug("Skipping BTP Cloud authorization (no btpDestination - local testing mode)", {
        type: "BTP_AUTH_SKIPPED",
      });
    }

    // ============================================
    // ABAP BLOCK: SAP ABAP Authentication
    // ============================================
    // If --mcp parameter or x-mcp-destination header is present:
    // - Use abapAuthBroker (with BtpTokenProvider)
    // - Check if x-sap-jwt-token header exists in original request
    // - Replace existing x-sap-jwt-token header or add new one
    // - Add x-sap-url and other SAP configuration headers
    if (routingDecision.mcpDestination) {
      // Check if x-sap-jwt-token header already exists in original request
      const existingSapToken = originalHeaders["x-sap-jwt-token"];
      const hasExistingSapToken = !!existingSapToken;
      
      // For ABAP destinations, use BtpTokenProvider (browser OAuth2 or refresh token)
      const connConfig = await this.abapAuthBroker.getConnectionConfig(routingDecision.mcpDestination);
      const sapUrl = connConfig?.serviceUrl;
      
      // Try to get token, but don't fail if it's not available (for local testing)
      try {
        const sapToken = await this.getJwtToken(routingDecision.mcpDestination, false, forceTokenRefresh);
        // Replace existing x-sap-jwt-token header or add new one
        proxyHeaders["x-sap-jwt-token"] = sapToken;
        logger.debug(hasExistingSapToken ? "Replaced existing x-sap-jwt-token header with ABAP token" : "Added SAP ABAP token", {
          type: hasExistingSapToken ? "SAP_TOKEN_REPLACED" : "SAP_TOKEN_ADDED",
          destination: routingDecision.mcpDestination,
          hadExistingToken: hasExistingSapToken,
        });
      } catch (error) {
        logger.warn("Failed to get SAP ABAP token (continuing without token for local testing)", {
          type: "SAP_TOKEN_SKIPPED",
          destination: routingDecision.mcpDestination,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue without token - this is OK for local testing
      }
      
      // Add SAP ABAP headers
      if (sapUrl) {
        proxyHeaders["x-sap-url"] = sapUrl;
      }
      proxyHeaders["x-sap-destination"] = routingDecision.mcpDestination;
      
      logger.debug("Added SAP ABAP configuration", {
        type: "SAP_CONFIG_ADDED",
        destination: routingDecision.mcpDestination,
        sapUrl: sapUrl || "not found",
        hasToken: !!proxyHeaders["x-sap-jwt-token"],
      });
    }

    // Preserve other original SAP headers if provided (only JWT-related headers)
    const sapHeaders = [
      "x-sap-client",
      "x-sap-auth-type",
    ];

    for (const headerName of sapHeaders) {
      const value = originalHeaders[headerName];
      if (value) {
        proxyHeaders[headerName] = Array.isArray(value) ? value[0] : value;
      }
    }

    // Get MCP server URL only from x-mcp-url header or --mcp-url parameter
    // Service URL is NOT obtained from service keys - only from explicit URL parameter/header
    let baseUrl: string | undefined;

    if (routingDecision.mcpUrl) {
      // Use direct URL from x-mcp-url header or --mcp-url parameter
      baseUrl = routingDecision.mcpUrl;
      logger.debug("Using MCP URL from x-mcp-url header or --mcp-url parameter", {
        type: "MCP_URL_FROM_HEADER",
        url: baseUrl,
      });
    } else {
      throw new Error("Cannot determine MCP server URL: x-mcp-url header or --mcp-url parameter is required");
    }

    // Construct full MCP endpoint URL
    // If baseUrl already contains the path, use it as-is
    // Otherwise, append default endpoint /mcp/stream/http
    let fullUrl: string;
    // Check if URL already contains MCP path (more flexible check)
    if (baseUrl.includes("/mcp/") || baseUrl.endsWith("/mcp") || baseUrl.includes("/mcp/stream/")) {
      // URL already contains MCP path - use as-is (but remove trailing slash if present)
      fullUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
      logger.debug("Using MCP URL as-is (already contains path)", {
        type: "MCP_URL_AS_IS",
        original: baseUrl,
        final: fullUrl,
      });
    } else {
      // Append default endpoint
      const mcpPath = "/mcp/stream/http";
      fullUrl = baseUrl.endsWith("/") 
        ? `${baseUrl.slice(0, -1)}${mcpPath}`
        : `${baseUrl}${mcpPath}`;
      logger.debug("Appended MCP path to base URL", {
        type: "MCP_URL_APPENDED",
        original: baseUrl,
        final: fullUrl,
      });
    }
    
    logger.debug("Built proxy request", {
      type: "PROXY_REQUEST_BUILT",
      btpDestination: routingDecision.btpDestination,
      mcpDestination: routingDecision.mcpDestination,
      mcpUrl: routingDecision.mcpUrl,
      baseUrl,
      fullUrl,
      hasAuthToken: !!proxyHeaders["Authorization"],
      hasSapConfig: !!proxyHeaders["x-sap-jwt-token"],
      sapHeaders: Object.keys(proxyHeaders).filter(h => h.startsWith("x-sap")),
    });

    // Return axios config with full URL
    return {
      method: "POST",
      url: fullUrl,
      headers: proxyHeaders,
      data: originalRequest,
    };
  }

  /**
   * Proxy MCP request to cloud-llm-hub with retry, circuit breaker, and error handling
   */
  async proxyRequest(
    originalRequest: ProxyRequest,
    routingDecision: RoutingDecision,
    originalHeaders: Record<string, string | string[] | undefined>
  ): Promise<ProxyResponse> {
    // Check circuit breaker
    if (!this.circuitBreaker.canProceed()) {
      logger.warn("Circuit breaker is open, rejecting request", {
        type: "CIRCUIT_BREAKER_REJECTED",
        btpDestination: routingDecision.btpDestination,
        mcpDestination: routingDecision.mcpDestination,
      });
      return createErrorResponse(
        originalRequest.id || null,
        -32001,
        "Service temporarily unavailable (circuit breaker open)",
        { circuitBreakerState: this.circuitBreaker.getState() }
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
        let forceTokenRefresh = false;

        // Build proxy request (will get fresh token if needed)
        const proxyConfig = await this.buildProxyRequest(
          originalRequest,
          routingDecision,
          originalHeaders,
          forceTokenRefresh
        );

        // Send request to cloud-llm-hub
        const response: AxiosResponse<ProxyResponse> = await this.axiosInstance.request(proxyConfig);

        // Record success in circuit breaker
        this.circuitBreaker.recordSuccess();

        logger.debug("Proxied request completed", {
          type: "PROXY_REQUEST_COMPLETED",
          status: response.status,
          hasResult: !!response.data?.result,
          hasError: !!response.data?.error,
        });

        return response;
      }, retryOptions);

      return response.data;
    } catch (error) {
      // Record failure in circuit breaker
      this.circuitBreaker.recordFailure();

      // Handle token expiration
      if (isTokenExpirationError(error)) {
        logger.warn("Token expiration detected, will retry with fresh token", {
          type: "TOKEN_EXPIRATION_DETECTED",
          btpDestination: routingDecision.btpDestination,
          mcpDestination: routingDecision.mcpDestination,
        });

        // Retry once with fresh token
        try {
          const proxyConfig = await this.buildProxyRequest(
            originalRequest,
            routingDecision,
            originalHeaders,
            true // Force token refresh
          );

          const response: AxiosResponse<ProxyResponse> = await this.axiosInstance.request(proxyConfig);
          this.circuitBreaker.recordSuccess();
          return response.data;
        } catch (retryError) {
          logger.error("Failed to retry with fresh token", {
            type: "TOKEN_REFRESH_RETRY_FAILED",
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
        }
      }

      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      const statusCode = axios.isAxiosError(error) && error.response?.status 
        ? error.response.status 
        : undefined;
      
      logger.error("Failed to proxy request to cloud-llm-hub", {
        type: "PROXY_REQUEST_ERROR",
        error: errorMessage,
        status: statusCode,
        circuitBreakerState: this.circuitBreaker.getState(),
      });

      // Output error to stderr for user visibility (only if verbose mode is enabled)
      if (shouldWriteStderr()) {
        if (statusCode) {
          process.stderr.write(`[MCP Proxy] ✗ Connection failed: ${errorMessage} (HTTP ${statusCode})\n`);
        } else {
          process.stderr.write(`[MCP Proxy] ✗ Connection failed: ${errorMessage}\n`);
        }
      }

      // Return error response in MCP format
      return createErrorResponse(
        originalRequest.id || null,
        statusCode || -32000,
        errorMessage,
        {
          circuitBreakerState: this.circuitBreaker.getState(),
          originalError: axios.isAxiosError(error) && error.response?.data
            ? error.response.data
            : undefined,
        }
      );
    }
  }
}

/**
 * Create Cloud LLM Hub Proxy instance
 */
export async function createCloudLlmHubProxy(
  cloudLlmHubUrl: string,
  config?: Partial<ProxyConfig>
): Promise<CloudLlmHubProxy> {
  const unsafe = config?.unsafe ?? false;
  
  // Get stores for BTP destinations (prefer XSUAA store)
  const { serviceKeyStore: btpServiceKeyStore, sessionStore: btpSessionStore } = await getPlatformStores(unsafe, true);
  
  // Get stores for ABAP destinations (prefer ABAP store)
  const { serviceKeyStore: abapServiceKeyStore, sessionStore: abapSessionStore } = await getPlatformStores(unsafe, false);
  
  // Create BTP auth broker with XsuaaTokenProvider (for BTP destinations)
  const xsuaaTokenProvider = new XsuaaTokenProvider();
  const btpAuthBroker = new AuthBroker(
    {
      serviceKeyStore: btpServiceKeyStore,
      sessionStore: btpSessionStore,
      tokenProvider: xsuaaTokenProvider,
    },
    "system"
  );
  
  // Create ABAP auth broker with BtpTokenProvider (for ABAP destinations)
  const btpTokenProvider = new BtpTokenProvider();
  const abapAuthBroker = new AuthBroker(
    {
      serviceKeyStore: abapServiceKeyStore,
      sessionStore: abapSessionStore,
      tokenProvider: btpTokenProvider,
    },
    "system"
  );

  return new CloudLlmHubProxy(cloudLlmHubUrl, btpAuthBroker, abapAuthBroker, config);
}


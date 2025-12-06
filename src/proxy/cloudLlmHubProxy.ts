/**
 * Cloud LLM Hub Proxy - Proxies requests to cloud-llm-hub with JWT authentication
 * 
 * For requests with x-sap-destination: "sk", proxies to cloud-llm-hub
 * with JWT token from auth-broker
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from "axios";
import { AuthBroker } from "@mcp-abap-adt/auth-broker";
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
  private authBroker: AuthBroker;
  private defaultBaseUrl: string;
  private tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
  private readonly TOKEN_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  private circuitBreaker: CircuitBreaker;
  private config: ProxyConfig;

  constructor(defaultBaseUrl: string, authBroker: AuthBroker, config?: Partial<ProxyConfig>) {
    // Default base URL (used if x-mcp-url is relative)
    this.defaultBaseUrl = defaultBaseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.authBroker = authBroker;
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
   */
  private async getJwtToken(destination: string, forceRefresh: boolean = false): Promise<string> {
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
        const token = await this.authBroker.getToken(destination);
        
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to get JWT token from auth-broker after retries", {
        type: "JWT_TOKEN_ERROR",
        destination,
        error: errorMessage,
      });
      // Output error to stderr for user visibility
      process.stderr.write(`[MCP Proxy] ✗ Failed to get token for destination "${destination}": ${errorMessage}\n`);
      throw error;
    }
  }

  /**
   * Build proxy request with JWT tokens and SAP configuration
   * 
   * Uses service keys:
   * 1. x-btp-destination - for BTP Cloud authorization (Authorization: Bearer token) - OPTIONAL
   * 2. x-mcp-destination - for SAP ABAP connection (SAP headers with token and config) - OPTIONAL
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

    // 1. Get authorization token for BTP Cloud (x-btp-destination or --btp) - OPTIONAL
    // This token is used for Authorization: Bearer header to connect to cloud MCP server
    // Only required if btpDestination is present
    if (routingDecision.btpDestination) {
      const authToken = await this.getJwtToken(routingDecision.btpDestination, forceTokenRefresh);
      proxyHeaders["Authorization"] = `Bearer ${authToken}`;
      
      logger.debug("Added BTP Cloud authorization token", {
        type: "BTP_AUTH_TOKEN_ADDED",
        destination: routingDecision.btpDestination,
      });
    } else {
      logger.debug("Skipping BTP Cloud authorization (no btpDestination - local testing mode)", {
        type: "BTP_AUTH_SKIPPED",
      });
    }

    // 2. Get SAP ABAP configuration from x-mcp-destination (OPTIONAL)
    // This provides token and configuration for SAP ABAP connection
    // Only used if x-mcp-destination or --mcp is provided
    // For local testing (without BTP), token retrieval is optional - URL is still needed
    if (routingDecision.mcpDestination) {
      const sapUrl = await this.authBroker.getSapUrl(routingDecision.mcpDestination);
      
      // Try to get token, but don't fail if it's not available (for local testing)
      try {
        const sapToken = await this.getJwtToken(routingDecision.mcpDestination, forceTokenRefresh);
        proxyHeaders["x-sap-jwt-token"] = sapToken;
        logger.debug("Added SAP ABAP token", {
          type: "SAP_TOKEN_ADDED",
          destination: routingDecision.mcpDestination,
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

    // Preserve other original SAP headers if provided
    const sapHeaders = [
      "x-sap-client",
      "x-sap-auth-type",
      "x-sap-login",
      "x-sap-password",
    ];

    for (const headerName of sapHeaders) {
      const value = originalHeaders[headerName];
      if (value) {
        proxyHeaders[headerName] = Array.isArray(value) ? value[0] : value;
      }
    }

    // Get MCP server URL from:
    // 1. x-mcp-url header (if provided) - direct URL
    // 2. BTP destination service key (if btpDestination is present)
    // 3. MCP destination service key (if only mcpDestination is present)
    let baseUrl: string | undefined;

    if (routingDecision.mcpUrl) {
      // Use direct URL from x-mcp-url header
      baseUrl = routingDecision.mcpUrl;
      logger.debug("Using MCP URL from x-mcp-url header", {
        type: "MCP_URL_FROM_HEADER",
        url: baseUrl,
      });
    } else if (routingDecision.btpDestination) {
      // Get URL from BTP destination service key
      baseUrl = await this.authBroker.getSapUrl(routingDecision.btpDestination);
      if (!baseUrl) {
        const errorMsg = `Failed to get MCP server URL from BTP destination "${routingDecision.btpDestination}". Check service key file.`;
        process.stderr.write(`[MCP Proxy] ✗ ${errorMsg}\n`);
        throw new Error(errorMsg);
      }
      logger.debug("Using MCP URL from BTP destination service key", {
        type: "MCP_URL_FROM_BTP",
        destination: routingDecision.btpDestination,
        url: baseUrl,
      });
    } else if (routingDecision.mcpDestination) {
      // Get URL from MCP destination service key (for local testing without BTP)
      baseUrl = await this.authBroker.getSapUrl(routingDecision.mcpDestination);
      if (!baseUrl) {
        const errorMsg = `Failed to get MCP server URL from MCP destination "${routingDecision.mcpDestination}". Check service key file.`;
        process.stderr.write(`[MCP Proxy] ✗ ${errorMsg}\n`);
        throw new Error(errorMsg);
      }
      logger.debug("Using MCP URL from MCP destination service key (local testing mode)", {
        type: "MCP_URL_FROM_MCP",
        destination: routingDecision.mcpDestination,
        url: baseUrl,
      });
    } else {
      throw new Error("Cannot determine MCP server URL: neither x-mcp-url header, btpDestination, nor mcpDestination is provided");
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
      logger.error("Failed to proxy request to cloud-llm-hub", {
        type: "PROXY_REQUEST_ERROR",
        error: errorMessage,
        status: axios.isAxiosError(error) ? error.response?.status : undefined,
        circuitBreakerState: this.circuitBreaker.getState(),
      });

      // Output error to stderr for user visibility
      const statusCode = axios.isAxiosError(error) && error.response?.status 
        ? error.response.status 
        : undefined;
      if (statusCode) {
        process.stderr.write(`[MCP Proxy] ✗ Connection failed: ${errorMessage} (HTTP ${statusCode})\n`);
      } else {
        process.stderr.write(`[MCP Proxy] ✗ Connection failed: ${errorMessage}\n`);
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
  const { serviceKeyStore, sessionStore } = await getPlatformStores(unsafe);
  const authBroker = new AuthBroker(
    {
      serviceKeyStore,
      sessionStore,
    },
    "system"
  );

  return new CloudLlmHubProxy(cloudLlmHubUrl, authBroker, config);
}


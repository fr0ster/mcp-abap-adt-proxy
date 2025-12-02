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
    this.axiosInstance = axios.create({
      timeout: this.config.requestTimeout || 60000,
      headers: {
        "Content-Type": "application/json",
      },
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
      logger.error("Failed to get JWT token from auth-broker after retries", {
        type: "JWT_TOKEN_ERROR",
        destination,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Build proxy request with JWT tokens and SAP configuration
   * 
   * Uses two service keys:
   * 1. x-btp-destination - for BTP Cloud authorization (Authorization: Bearer token)
   * 2. x-mcp-destination - for SAP ABAP connection (SAP headers with token and config)
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

    // 1. Get authorization token for BTP Cloud (x-btp-destination)
    // This token is used for Authorization: Bearer header to connect to cloud MCP server
    if (routingDecision.btpDestination) {
      const authToken = await this.getJwtToken(routingDecision.btpDestination, forceTokenRefresh);
      proxyHeaders["Authorization"] = `Bearer ${authToken}`;
      
      logger.debug("Added BTP Cloud authorization token", {
        type: "BTP_AUTH_TOKEN_ADDED",
        destination: routingDecision.btpDestination,
      });
    }

    // 2. Get SAP ABAP configuration from x-mcp-destination
    // This provides token and configuration for SAP ABAP connection
    if (routingDecision.mcpDestination) {
      const sapToken = await this.getJwtToken(routingDecision.mcpDestination, forceTokenRefresh);
      const sapUrl = await this.authBroker.getSapUrl(routingDecision.mcpDestination);
      
      // Add SAP ABAP headers
      proxyHeaders["x-sap-jwt-token"] = sapToken;
      if (sapUrl) {
        proxyHeaders["x-sap-url"] = sapUrl;
      }
      proxyHeaders["x-sap-destination"] = routingDecision.mcpDestination;
      
      logger.debug("Added SAP ABAP configuration", {
        type: "SAP_CONFIG_ADDED",
        destination: routingDecision.mcpDestination,
        sapUrl: sapUrl || "not found",
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

    // Use full URL from x-mcp-url header
    // x-mcp-url should contain the full URL to the MCP server (e.g., "https://example.com/mcp/stream/http")
    const mcpUrl = routingDecision.mcpUrl;
    if (!mcpUrl) {
      throw new Error("x-mcp-url header is required for proxying");
    }

    // Determine if mcpUrl is a full URL or relative path
    let fullUrl: string;
    try {
      // Try to parse as URL - if successful, it's a full URL
      new URL(mcpUrl);
      fullUrl = mcpUrl;
    } catch (error) {
      // If parsing fails, treat as relative path and prepend default base URL
      const path = mcpUrl.startsWith("/") ? mcpUrl : `/${mcpUrl}`;
      fullUrl = `${this.defaultBaseUrl}${path}`;
    }
    
    logger.debug("Built proxy request", {
      type: "PROXY_REQUEST_BUILT",
      btpDestination: routingDecision.btpDestination,
      mcpDestination: routingDecision.mcpDestination,
      mcpUrl,
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

      logger.error("Failed to proxy request to cloud-llm-hub", {
        type: "PROXY_REQUEST_ERROR",
        error: error instanceof Error ? error.message : String(error),
        status: axios.isAxiosError(error) ? error.response?.status : undefined,
        circuitBreakerState: this.circuitBreaker.getState(),
      });

      // Return error response in MCP format
      return createErrorResponse(
        originalRequest.id || null,
        axios.isAxiosError(error) && error.response?.status
          ? error.response.status
          : -32000,
        error instanceof Error ? error.message : "Unknown error",
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
  const { serviceKeyStore, sessionStore } = await getPlatformStores();
  const authBroker = new AuthBroker(
    {
      serviceKeyStore,
      sessionStore,
    },
    "system"
  );

  return new CloudLlmHubProxy(cloudLlmHubUrl, authBroker, config);
}


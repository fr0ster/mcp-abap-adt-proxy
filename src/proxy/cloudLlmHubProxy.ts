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
  private cloudLlmHubUrl: string;
  private tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
  private readonly TOKEN_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
  private circuitBreaker: CircuitBreaker;
  private config: ProxyConfig;

  constructor(cloudLlmHubUrl: string, authBroker: AuthBroker, config?: Partial<ProxyConfig>) {
    this.cloudLlmHubUrl = cloudLlmHubUrl.replace(/\/$/, ""); // Remove trailing slash
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

    this.axiosInstance = axios.create({
      baseURL: this.cloudLlmHubUrl,
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
   * Build proxy request with JWT token and original headers
   */
  private async buildProxyRequest(
    originalRequest: ProxyRequest,
    routingDecision: RoutingDecision,
    originalHeaders: Record<string, string | string[] | undefined>,
    forceTokenRefresh: boolean = false
  ): Promise<AxiosRequestConfig> {
    const destination = routingDecision.destination || "sk";
    const jwtToken = await this.getJwtToken(destination, forceTokenRefresh);

    // Build headers for cloud-llm-hub
    const proxyHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwtToken}`,
    };

    // Preserve original SAP connection headers
    // These will be used by cloud-llm-hub to connect to cloud ABAP
    const sapHeaders = [
      "x-sap-url",
      "x-sap-client",
      "x-sap-destination",
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

    // Add original destination if not already set
    if (!proxyHeaders["x-sap-destination"] && destination) {
      proxyHeaders["x-sap-destination"] = destination;
    }

    logger.debug("Built proxy request", {
      type: "PROXY_REQUEST_BUILT",
      destination,
      hasJwtToken: !!jwtToken,
      preservedHeaders: Object.keys(proxyHeaders).filter(h => h.startsWith("x-sap")),
    });

    return {
      method: "POST",
      url: "/mcp/stream/http", // Cloud-llm-hub MCP endpoint
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
        destination: routingDecision.destination,
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
        const destination = routingDecision.destination || "sk";
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
          destination: routingDecision.destination,
        });

        // Retry once with fresh token
        try {
          const destination = routingDecision.destination || "sk";
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


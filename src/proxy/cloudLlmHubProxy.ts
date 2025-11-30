/**
 * Cloud LLM Hub Proxy - Proxies requests to cloud-llm-hub with JWT authentication
 * 
 * For requests with x-sap-destination: "sk", proxies to cloud-llm-hub
 * with JWT token from auth-broker
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { AuthBroker } from "@mcp-abap-adt/auth-broker";
import { logger } from "../lib/logger.js";
import { RoutingDecision } from "../router/headerAnalyzer.js";
import { loadConfig } from "../lib/config.js";
import { getPlatformStores } from "../lib/stores.js";

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

  constructor(cloudLlmHubUrl: string, authBroker: AuthBroker) {
    this.cloudLlmHubUrl = cloudLlmHubUrl.replace(/\/$/, ""); // Remove trailing slash
    this.authBroker = authBroker;

    this.axiosInstance = axios.create({
      baseURL: this.cloudLlmHubUrl,
      timeout: 60000, // 60 seconds
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
   * Get JWT token for destination from auth-broker
   */
  private async getJwtToken(destination: string): Promise<string> {
    // Check cache first
    const cached = this.tokenCache.get(destination);
    if (cached && cached.expiresAt > Date.now()) {
      logger.debug("Using cached JWT token", {
        type: "JWT_TOKEN_CACHE_HIT",
        destination,
      });
      return cached.token;
    }

    try {
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
      });

      return token;
    } catch (error) {
      logger.error("Failed to get JWT token from auth-broker", {
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
    originalHeaders: Record<string, string | string[] | undefined>
  ): Promise<AxiosRequestConfig> {
    const destination = routingDecision.destination || "sk";
    const jwtToken = await this.getJwtToken(destination);

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
   * Proxy MCP request to cloud-llm-hub
   */
  async proxyRequest(
    originalRequest: ProxyRequest,
    routingDecision: RoutingDecision,
    originalHeaders: Record<string, string | string[] | undefined>
  ): Promise<ProxyResponse> {
    try {
      // Build proxy request
      const proxyConfig = await this.buildProxyRequest(
        originalRequest,
        routingDecision,
        originalHeaders
      );

      // Send request to cloud-llm-hub
      const response: AxiosResponse<ProxyResponse> = await this.axiosInstance.request(proxyConfig);

      logger.debug("Proxied request completed", {
        type: "PROXY_REQUEST_COMPLETED",
        status: response.status,
        hasResult: !!response.data?.result,
        hasError: !!response.data?.error,
      });

      return response.data;
    } catch (error) {
      logger.error("Failed to proxy request to cloud-llm-hub", {
        type: "PROXY_REQUEST_ERROR",
        error: error instanceof Error ? error.message : String(error),
        status: axios.isAxiosError(error) ? error.response?.status : undefined,
      });

      // Return error response in MCP format
      return {
        jsonrpc: "2.0",
        id: originalRequest.id || null,
        error: {
          code: axios.isAxiosError(error) && error.response?.status
            ? error.response.status
            : -32000,
          message: error instanceof Error ? error.message : "Unknown error",
          data: axios.isAxiosError(error) && error.response?.data
            ? error.response.data
            : undefined,
        },
      };
    }
  }
}

/**
 * Create Cloud LLM Hub Proxy instance
 */
export async function createCloudLlmHubProxy(
  cloudLlmHubUrl: string
): Promise<CloudLlmHubProxy> {
  const { serviceKeyStore, sessionStore } = await getPlatformStores();
  const authBroker = new AuthBroker(
    {
      serviceKeyStore,
      sessionStore,
    },
    "system"
  );

  return new CloudLlmHubProxy(cloudLlmHubUrl, authBroker);
}


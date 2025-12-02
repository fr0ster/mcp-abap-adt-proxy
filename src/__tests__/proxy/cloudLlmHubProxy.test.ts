/**
 * Unit tests for cloudLlmHubProxy
 */

import { CloudLlmHubProxy, ProxyRequest, ProxyResponse } from "../../proxy/cloudLlmHubProxy.js";
import { AuthBroker } from "@mcp-abap-adt/auth-broker";
import { RoutingDecision, RoutingStrategy } from "../../router/headerAnalyzer.js";
import axios, { AxiosInstance, AxiosResponse } from "axios";

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock AuthBroker
jest.mock("@mcp-abap-adt/auth-broker");

describe("CloudLlmHubProxy", () => {
  let proxy: CloudLlmHubProxy;
  let mockAuthBroker: jest.Mocked<AuthBroker>;
  let mockAxiosInstance: jest.Mocked<AxiosInstance>;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock AuthBroker
    mockAuthBroker = {
      getToken: jest.fn(),
      getSapUrl: jest.fn(),
    } as any;

    // Create mock axios instance
    mockAxiosInstance = {
      request: jest.fn(),
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    } as any;

    // Mock axios.create
    mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);

    // Create proxy instance
    proxy = new CloudLlmHubProxy("https://default.example.com", mockAuthBroker, {
      maxRetries: 2,
      retryDelay: 100,
      requestTimeout: 5000,
    });
  });

  describe("buildProxyRequest", () => {
    it("should require btpDestination and add Authorization header", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpUrl: "https://target.example.com/mcp/stream/http",
        reason: "Test",
      };

      mockAuthBroker.getToken.mockResolvedValue("btp-token-123");

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
      expect(mockAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
    });

    it("should add SAP headers from x-mcp-destination", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpDestination: "sap-abap",
        mcpUrl: "https://target.example.com/mcp/stream/http",
        reason: "Test",
      };

      mockAuthBroker.getToken
        .mockResolvedValueOnce("btp-token-123")
        .mockResolvedValueOnce("sap-token-456");
      mockAuthBroker.getSapUrl.mockResolvedValue("https://sap.example.com");

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
      expect(config.headers["x-sap-jwt-token"]).toBe("sap-token-456");
      expect(config.headers["x-sap-url"]).toBe("https://sap.example.com");
      expect(config.headers["x-sap-destination"]).toBe("sap-abap");
      expect(mockAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
      expect(mockAuthBroker.getToken).toHaveBeenCalledWith("sap-abap");
      expect(mockAuthBroker.getSapUrl).toHaveBeenCalledWith("sap-abap");
    });

    it("should add both Authorization and SAP headers when both are provided", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpDestination: "sap-abap",
        mcpUrl: "https://target.example.com/mcp/stream/http",
        reason: "Test",
      };

      mockAuthBroker.getToken
        .mockResolvedValueOnce("btp-token-123")
        .mockResolvedValueOnce("sap-token-456");
      mockAuthBroker.getSapUrl.mockResolvedValue("https://sap.example.com");

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
      expect(config.headers["x-sap-jwt-token"]).toBe("sap-token-456");
      expect(config.headers["x-sap-url"]).toBe("https://sap.example.com");
      expect(mockAuthBroker.getToken).toHaveBeenCalledTimes(2);
    });

    it("should use full URL from x-mcp-url when provided", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpUrl: "https://target.example.com/mcp/stream/http",
        reason: "Test",
      };

      mockAuthBroker.getToken.mockResolvedValue("btp-token-123");

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.url).toBe("https://target.example.com/mcp/stream/http");
      expect(config.method).toBe("POST");
      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
    });

    it("should handle relative path in x-mcp-url", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpUrl: "/mcp/stream/http",
        reason: "Test",
      };

      mockAuthBroker.getToken.mockResolvedValue("btp-token-123");

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.url).toBe("https://default.example.com/mcp/stream/http");
      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
    });

    it("should preserve other SAP headers from original request", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpDestination: "sap-abap",
        mcpUrl: "https://target.example.com/mcp/stream/http",
        reason: "Test",
      };

      const originalHeaders = {
        "x-sap-client": "100",
        "x-sap-auth-type": "jwt",
      };

      mockAuthBroker.getToken
        .mockResolvedValueOnce("btp-token-123")
        .mockResolvedValueOnce("sap-token-456");
      mockAuthBroker.getSapUrl.mockResolvedValue("https://sap.example.com");

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        originalHeaders
      );

      expect(config.headers["x-sap-client"]).toBe("100");
      expect(config.headers["x-sap-auth-type"]).toBe("jwt");
    });

    it("should throw error if btpDestination is missing", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        mcpUrl: "https://target.example.com/mcp/stream/http",
        reason: "Test",
      };

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      
      await expect(
        buildProxyRequest(
          { method: "tools/list" },
          routingDecision,
          {}
        )
      ).rejects.toThrow("btpDestination is required");
    });

    it("should work without mcpDestination (optional)", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpUrl: "https://target.example.com/mcp/stream/http",
        reason: "Test",
      };

      mockAuthBroker.getToken.mockResolvedValue("btp-token-123");

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
      expect(config.headers["x-sap-jwt-token"]).toBeUndefined();
      expect(mockAuthBroker.getToken).toHaveBeenCalledTimes(1);
      expect(mockAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
    });
  });

  describe("proxyRequest", () => {
    it("should successfully proxy request with both tokens", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpDestination: "sap-abap",
        mcpUrl: "https://target.example.com/mcp/stream/http",
        reason: "Test",
      };

      const request: ProxyRequest = {
        method: "tools/list",
        params: {},
        id: 1,
        jsonrpc: "2.0",
      };

      const mockResponse: AxiosResponse<ProxyResponse> = {
        data: {
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [] },
        },
        status: 200,
        statusText: "OK",
        headers: {},
        config: {} as any,
      };

      mockAuthBroker.getToken
        .mockResolvedValueOnce("btp-token-123")
        .mockResolvedValueOnce("sap-token-456");
      mockAuthBroker.getSapUrl.mockResolvedValue("https://sap.example.com");
      mockAxiosInstance.request.mockResolvedValue(mockResponse);

      const response = await proxy.proxyRequest(request, routingDecision, {});

      expect(response.result).toEqual({ tools: [] });
      expect(mockAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
      expect(mockAuthBroker.getToken).toHaveBeenCalledWith("sap-abap");
      expect(mockAxiosInstance.request).toHaveBeenCalled();
    });

    it("should handle errors and return error response", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpUrl: "https://target.example.com/mcp/stream/http",
        reason: "Test",
      };

      const request: ProxyRequest = {
        method: "tools/list",
        params: {},
        id: 1,
        jsonrpc: "2.0",
      };

      mockAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockAxiosInstance.request.mockRejectedValue(new Error("Network error"));

      const response = await proxy.proxyRequest(request, routingDecision, {});

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32000);
      expect(response.error?.message).toContain("Network error");
    });

    it("should cache tokens separately for authorization and destination", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpDestination: "sap-abap",
        mcpUrl: "https://target.example.com/mcp/stream/http",
        reason: "Test",
      };

      const mockResponse: AxiosResponse<ProxyResponse> = {
        data: { jsonrpc: "2.0", id: 1, result: {} },
        status: 200,
        statusText: "OK",
        headers: {},
        config: {} as any,
      };

      mockAuthBroker.getToken
        .mockResolvedValueOnce("btp-token-123")
        .mockResolvedValueOnce("sap-token-456");
      mockAuthBroker.getSapUrl.mockResolvedValue("https://sap.example.com");
      mockAxiosInstance.request.mockResolvedValue(mockResponse);

      // First request
      await proxy.proxyRequest(
        { method: "tools/list", id: 1 },
        routingDecision,
        {}
      );

      // Second request - should use cached tokens
      await proxy.proxyRequest(
        { method: "tools/list", id: 2 },
        routingDecision,
        {}
      );

      // getToken should be called only twice (once for each destination, cached on second call)
      expect(mockAuthBroker.getToken).toHaveBeenCalledTimes(2);
    });
  });
});

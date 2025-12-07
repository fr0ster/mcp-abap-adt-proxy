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
  let mockBtpAuthBroker: jest.Mocked<AuthBroker>;
  let mockAbapAuthBroker: jest.Mocked<AuthBroker>;
  let mockAxiosInstance: jest.Mocked<AxiosInstance>;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock BTP AuthBroker (for XSUAA/BTP destinations)
    mockBtpAuthBroker = {
      getToken: jest.fn(),
      getConnectionConfig: jest.fn(),
    } as any;

    // Create mock ABAP AuthBroker (for ABAP destinations)
    mockAbapAuthBroker = {
      getToken: jest.fn(),
      getConnectionConfig: jest.fn(),
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

    // Create proxy instance with both BTP and ABAP auth brokers
    proxy = new CloudLlmHubProxy("https://default.example.com", mockBtpAuthBroker, mockAbapAuthBroker, {
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
        reason: "Test",
      };

      // BTP destination uses btpAuthBroker (XsuaaTokenProvider)
      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com", authorizationToken: "" });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
      expect(config.url).toBe("https://target.example.com/mcp/stream/http");
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
      expect(mockBtpAuthBroker.getConnectionConfig).toHaveBeenCalledWith("btp-cloud");
    });

    it("should add SAP headers from x-mcp-destination", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpDestination: "sap-abap",
        reason: "Test",
      };

      // BTP destination uses btpAuthBroker (XsuaaTokenProvider)
      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com", authorizationToken: "" });

      // ABAP destination uses abapAuthBroker (BtpTokenProvider)
      mockAbapAuthBroker.getToken.mockResolvedValue("sap-token-456");
      mockAbapAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://sap.example.com", authorizationToken: "" });

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
      expect(config.url).toBe("https://target.example.com/mcp/stream/http");
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
      expect(mockAbapAuthBroker.getToken).toHaveBeenCalledWith("sap-abap");
      expect(mockBtpAuthBroker.getConnectionConfig).toHaveBeenCalledWith("btp-cloud");
      expect(mockAbapAuthBroker.getConnectionConfig).toHaveBeenCalledWith("sap-abap");
    });

    it("should add both Authorization and SAP headers when both are provided", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpDestination: "sap-abap",
        reason: "Test",
      };

      // BTP destination uses btpAuthBroker
      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com", authorizationToken: "" });
      
      // ABAP destination uses abapAuthBroker
      mockAbapAuthBroker.getToken.mockResolvedValue("sap-token-456");
      mockAbapAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://sap.example.com", authorizationToken: "" });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
      expect(config.headers["x-sap-jwt-token"]).toBe("sap-token-456");
      expect(config.headers["x-sap-url"]).toBe("https://sap.example.com");
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledTimes(1);
      expect(mockAbapAuthBroker.getToken).toHaveBeenCalledTimes(1);
    });

    it("should get URL from BTP destination service key", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        reason: "Test",
      };

      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com", authorizationToken: "" });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.url).toBe("https://target.example.com/mcp/stream/http");
      expect(config.method).toBe("POST");
      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
      expect(mockBtpAuthBroker.getConnectionConfig).toHaveBeenCalledWith("btp-cloud");
    });

    it("should handle base URL with trailing slash", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        reason: "Test",
      };

      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com/", authorizationToken: "" });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.url).toBe("https://target.example.com/mcp/stream/http");
      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
    });

    it("should preserve other SAP headers from original request", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpDestination: "sap-abap",
        reason: "Test",
      };

      const originalHeaders = {
        "x-sap-client": "100",
        "x-sap-auth-type": "jwt",
      };

      // BTP destination uses btpAuthBroker
      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com", authorizationToken: "" });
      
      // ABAP destination uses abapAuthBroker
      mockAbapAuthBroker.getToken.mockResolvedValue("sap-token-456");
      mockAbapAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://sap.example.com", authorizationToken: "" });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        originalHeaders
      );

      expect(config.headers["x-sap-client"]).toBe("100");
      expect(config.headers["x-sap-auth-type"]).toBe("jwt");
    });

    it("should throw error if both btpDestination and mcpDestination are missing", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        reason: "Test",
      };

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      
      await expect(
        buildProxyRequest(
          { method: "tools/list" },
          routingDecision,
          {}
        )
      ).rejects.toThrow("Cannot determine MCP server URL");
    });

    it("should work with only mcpDestination (local testing mode)", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        mcpDestination: "sap-abap",
        reason: "Test",
      };

      // Mock abapAuthBroker methods for mcpDestination (ABAP destination uses abapAuthBroker)
      (mockAbapAuthBroker.getConnectionConfig as jest.Mock).mockResolvedValue({ serviceUrl: "https://sap.example.com", authorizationToken: "" });
      (mockAbapAuthBroker.getToken as jest.Mock).mockResolvedValue("mcp-token");

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      
      const result = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(result).toBeDefined();
      expect(result.url).toContain("https://sap.example.com");
      expect(result.headers["Authorization"]).toBeUndefined(); // No BTP auth in local testing mode
      expect(result.headers["x-sap-jwt-token"]).toBe("mcp-token");
      expect(mockAbapAuthBroker.getConnectionConfig).toHaveBeenCalledWith("sap-abap");
      expect(mockAbapAuthBroker.getToken).toHaveBeenCalledWith("sap-abap");
    });

    it("should work without mcpDestination (optional)", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        reason: "Test",
      };

      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com", authorizationToken: "" });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: "tools/list" },
        routingDecision,
        {}
      );

      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
      expect(config.headers["x-sap-jwt-token"]).toBeUndefined();
      expect(config.url).toBe("https://target.example.com/mcp/stream/http");
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledTimes(1);
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
      expect(mockBtpAuthBroker.getConnectionConfig).toHaveBeenCalledWith("btp-cloud");
    });
  });

  describe("proxyRequest", () => {
    it("should successfully proxy request with both tokens", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpDestination: "sap-abap",
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

      // BTP destination uses btpAuthBroker
      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com", authorizationToken: "" });
      
      // ABAP destination uses abapAuthBroker
      mockAbapAuthBroker.getToken.mockResolvedValue("sap-token-456");
      mockAbapAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://sap.example.com", authorizationToken: "" });
      
      mockAxiosInstance.request.mockResolvedValue(mockResponse);

      const response = await proxy.proxyRequest(request, routingDecision, {});

      expect(response.result).toEqual({ tools: [] });
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
      expect(mockAbapAuthBroker.getToken).toHaveBeenCalledWith("sap-abap");
      expect(mockAxiosInstance.request).toHaveBeenCalled();
    });

    it("should handle errors and return error response", async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        reason: "Test",
      };

      const request: ProxyRequest = {
        method: "tools/list",
        params: {},
        id: 1,
        jsonrpc: "2.0",
      };

      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com", authorizationToken: "" });
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
        reason: "Test",
      };

      const mockResponse: AxiosResponse<ProxyResponse> = {
        data: { jsonrpc: "2.0", id: 1, result: {} },
        status: 200,
        statusText: "OK",
        headers: {},
        config: {} as any,
      };

      // BTP destination uses btpAuthBroker
      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com", authorizationToken: "" });
      
      // ABAP destination uses abapAuthBroker
      mockAbapAuthBroker.getToken.mockResolvedValue("sap-token-456");
      mockAbapAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://sap.example.com", authorizationToken: "" });
      
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

      // getToken should be called once for each destination (BTP and ABAP)
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledTimes(1);
      expect(mockAbapAuthBroker.getToken).toHaveBeenCalledTimes(1);
    });
  });
});

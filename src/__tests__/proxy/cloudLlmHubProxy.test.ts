/**
 * Unit tests for cloudLlmHubProxy
 */

import { CloudLlmHubProxy, ProxyRequest, ProxyResponse } from "../../proxy/cloudLlmHubProxy.js";
import { AuthBroker } from "@mcp-abap-adt/auth-broker";
import { RoutingDecision, RoutingStrategy } from "../../router/headerAnalyzer.js";
import {
  HEADER_AUTHORIZATION,
  HEADER_SAP_JWT_TOKEN,
  HEADER_SAP_URL,
  HEADER_SAP_CLIENT,
  HEADER_SAP_AUTH_TYPE,
  AUTH_TYPE_JWT,
} from "@mcp-abap-adt/interfaces";
import axios, { AxiosInstance, AxiosResponse } from "axios";
import { testLogger, getPackageLogger } from "../helpers/testLogger.js";

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock AuthBroker
jest.mock("@mcp-abap-adt/auth-broker");

// Mock getPlatformStores to avoid creating real stores in tests
jest.mock("../../lib/stores.js", () => ({
  getPlatformStores: jest.fn().mockResolvedValue({
    serviceKeyStore: {
      getAuthorizationConfig: jest.fn(),
      getConnectionConfig: jest.fn(),
    },
    sessionStore: {
      saveSession: jest.fn(),
      loadSession: jest.fn(),
    },
  }),
}));

// Mock token providers to avoid creating real instances
jest.mock("@mcp-abap-adt/auth-providers", () => ({
  XsuaaTokenProvider: jest.fn(),
  BtpTokenProvider: jest.fn(),
}));

describe("CloudLlmHubProxy", () => {
  let proxy: CloudLlmHubProxy;
  let mockBtpAuthBroker: jest.Mocked<AuthBroker>;
  let mockAbapAuthBroker: jest.Mocked<AuthBroker>;
  let mockAxiosInstance: jest.Mocked<AxiosInstance>;

  beforeEach(() => {
    testLogger.debug("Setting up CloudLlmHubProxy test");
    
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

    // Mock AuthBroker constructor to return appropriate mock based on browser parameter
    // In real tests, you would use: new AuthBroker(stores, browser, getPackageLogger('AUTH_BROKER'))
    (AuthBroker as jest.MockedClass<typeof AuthBroker>).mockImplementation((stores: any, browser?: string, logger?: any) => {
      testLogger.debug(`Creating mock AuthBroker with browser=${browser}`, { browser, hasLogger: !!logger });
      // Return BTP mock for XSUAA (browser === 'none') or ABAP mock for ABAP (browser === 'system')
      if (browser === 'none') {
        return mockBtpAuthBroker as any;
      } else {
        return mockAbapAuthBroker as any;
      }
    });

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
      testLogger.info("Test: should require btpDestination and add Authorization header");
      
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        reason: "Test",
      };

      const request = { method: "tools/list" };
      const originalHeaders = {};

      testLogger.info("Input parameters", { 
        routingDecision: {
          strategy: routingDecision.strategy,
          btpDestination: routingDecision.btpDestination,
          mcpDestination: routingDecision.mcpDestination
        },
        request,
        originalHeaders
      });

      // BTP destination uses btpAuthBroker (XsuaaTokenProvider)
      const mockToken = "btp-token-123";
      const mockConnectionConfig = { serviceUrl: "https://target.example.com", authorizationToken: "" };
      
      mockBtpAuthBroker.getToken.mockResolvedValue(mockToken);
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue(mockConnectionConfig);

      testLogger.info("Mock configuration - simulating service key and token retrieval", { 
        btpDestination: "btp-cloud",
        mockToken,
        mockConnectionConfig,
        explanation: "Mocking AuthBroker.getToken() and getConnectionConfig() calls that would normally read from service key store"
      });

      testLogger.info("Calling buildProxyRequest", {
        function: "buildProxyRequest",
        willCall: [
          "btpAuthBroker.getToken('btp-cloud')",
          "btpAuthBroker.getConnectionConfig('btp-cloud')"
        ]
      });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(request, routingDecision, originalHeaders);

      testLogger.info("Proxy request config result", { 
        url: config.url,
        method: config.method,
        headers: {
          authorization: config.headers["Authorization"],
          allHeaders: config.headers,
          allHeaderKeys: Object.keys(config.headers || {})
        },
        expectedUrl: "https://target.example.com/mcp/stream/http",
        expectedAuth: `Bearer ${mockToken}`
      });

      testLogger.info("Mock method calls executed", {
        getToken: {
          called: mockBtpAuthBroker.getToken.mock.calls.length > 0,
          callCount: mockBtpAuthBroker.getToken.mock.calls.length,
          calls: mockBtpAuthBroker.getToken.mock.calls.map((call, idx) => ({
            callNumber: idx + 1,
            destination: call[0],
            expected: "btp-cloud"
          })),
          returnedToken: mockToken
        },
        getConnectionConfig: {
          called: mockBtpAuthBroker.getConnectionConfig.mock.calls.length > 0,
          callCount: mockBtpAuthBroker.getConnectionConfig.mock.calls.length,
          calls: mockBtpAuthBroker.getConnectionConfig.mock.calls.map((call, idx) => ({
            callNumber: idx + 1,
            destination: call[0],
            expected: "btp-cloud"
          })),
          returnedConfig: mockConnectionConfig
        }
      });

      testLogger.info("Verifying assertions", {
        checking: [
          "Authorization header contains Bearer token",
          "URL is constructed from serviceUrl",
          "getToken called with correct destination",
          "getConnectionConfig called with correct destination"
        ]
      });

      expect(config.headers["Authorization"]).toBe("Bearer btp-token-123");
      expect(config.url).toBe("https://target.example.com/mcp/stream/http");
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
      expect(mockBtpAuthBroker.getConnectionConfig).toHaveBeenCalledWith("btp-cloud");
      
      testLogger.info("All assertions passed", {
        authorizationHeader: config.headers["Authorization"] === `Bearer ${mockToken}`,
        url: config.url === mockConnectionConfig.serviceUrl + "/mcp/stream/http",
        tokenRetrieved: true,
        connectionConfigRetrieved: true
      });
    });

    it("should add SAP headers from x-mcp-destination", async () => {
      testLogger.info("Test: should add SAP headers from x-mcp-destination");
      
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        mcpDestination: "sap-abap",
        reason: "Test",
      };

      const request = { method: "tools/list" };
      const originalHeaders = {};

      testLogger.debug("Input parameters", { 
        routingDecision: {
          strategy: routingDecision.strategy,
          btpDestination: routingDecision.btpDestination,
          mcpDestination: routingDecision.mcpDestination
        },
        request,
        originalHeaders
      });

      // BTP destination uses btpAuthBroker (XsuaaTokenProvider)
      const btpToken = "btp-token-123";
      const btpConnectionConfig = { serviceUrl: "https://target.example.com", authorizationToken: "" };
      
      // ABAP destination uses abapAuthBroker (BtpTokenProvider)
      const abapToken = "sap-token-456";
      const abapConnectionConfig = { serviceUrl: "https://sap.example.com", authorizationToken: "" };

      mockBtpAuthBroker.getToken.mockResolvedValue(btpToken);
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue(btpConnectionConfig);
      mockAbapAuthBroker.getToken.mockResolvedValue(abapToken);
      mockAbapAuthBroker.getConnectionConfig.mockResolvedValue(abapConnectionConfig);

      testLogger.debug("Mock configuration", { 
        btp: {
          destination: "btp-cloud",
          token: btpToken,
          connectionConfig: btpConnectionConfig
        },
        abap: {
          destination: "sap-abap",
          token: abapToken,
          connectionConfig: abapConnectionConfig
        }
      });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(request, routingDecision, originalHeaders);

      testLogger.debug("Proxy request config result", {
        url: config.url,
        method: config.method,
        headers: {
          authorization: config.headers[HEADER_AUTHORIZATION],
          sapJwtToken: config.headers[HEADER_SAP_JWT_TOKEN],
          sapUrl: config.headers[HEADER_SAP_URL],
          allHeaderKeys: Object.keys(config.headers || {})
        },
        expectedHeaders: {
          authorization: `Bearer ${btpToken}`,
          sapJwtToken: abapToken,
          sapUrl: abapConnectionConfig.serviceUrl
        }
      });

      testLogger.debug("Mock method calls", {
        btpBroker: {
          getToken: {
            called: mockBtpAuthBroker.getToken.mock.calls.length > 0,
            calls: mockBtpAuthBroker.getToken.mock.calls,
            expectedWith: "btp-cloud"
          },
          getConnectionConfig: {
            called: mockBtpAuthBroker.getConnectionConfig.mock.calls.length > 0,
            calls: mockBtpAuthBroker.getConnectionConfig.mock.calls,
            expectedWith: "btp-cloud"
          }
        },
        abapBroker: {
          getToken: {
            called: mockAbapAuthBroker.getToken.mock.calls.length > 0,
            calls: mockAbapAuthBroker.getToken.mock.calls,
            expectedWith: "sap-abap"
          },
          getConnectionConfig: {
            called: mockAbapAuthBroker.getConnectionConfig.mock.calls.length > 0,
            calls: mockAbapAuthBroker.getConnectionConfig.mock.calls,
            expectedWith: "sap-abap"
          }
        }
      });

      expect(config.headers[HEADER_AUTHORIZATION]).toBe("Bearer btp-token-123");
      expect(config.headers[HEADER_SAP_JWT_TOKEN]).toBe("sap-token-456");
      expect(config.headers[HEADER_SAP_URL]).toBe("https://sap.example.com");
      // x-sap-destination is not added by proxy, only by client
      expect(config.url).toBe("https://target.example.com/mcp/stream/http");
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
      expect(mockAbapAuthBroker.getToken).toHaveBeenCalledWith("sap-abap");
      expect(mockBtpAuthBroker.getConnectionConfig).toHaveBeenCalledWith("btp-cloud");
      expect(mockAbapAuthBroker.getConnectionConfig).toHaveBeenCalledWith("sap-abap");
      
      testLogger.debug("Assertions passed", {
        authorizationHeader: config.headers[HEADER_AUTHORIZATION] === `Bearer ${btpToken}`,
        sapJwtToken: config.headers[HEADER_SAP_JWT_TOKEN] === abapToken,
        sapUrl: config.headers[HEADER_SAP_URL] === abapConnectionConfig.serviceUrl,
        url: config.url === btpConnectionConfig.serviceUrl + "/mcp/stream/http"
      });
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

      expect(config.headers[HEADER_AUTHORIZATION]).toBe("Bearer btp-token-123");
      expect(config.headers[HEADER_SAP_JWT_TOKEN]).toBe("sap-token-456");
      expect(config.headers[HEADER_SAP_URL]).toBe("https://sap.example.com");
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
        [HEADER_SAP_CLIENT]: "100",
        [HEADER_SAP_AUTH_TYPE]: AUTH_TYPE_JWT,
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

      expect(config.headers[HEADER_SAP_CLIENT]).toBe("100");
      expect(config.headers[HEADER_SAP_AUTH_TYPE]).toBe(AUTH_TYPE_JWT);
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
      expect(result.headers[HEADER_AUTHORIZATION]).toBeUndefined(); // No BTP auth in local testing mode
      expect(result.headers[HEADER_SAP_JWT_TOKEN]).toBe("mcp-token");
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

      expect(config.headers[HEADER_AUTHORIZATION]).toBe("Bearer btp-token-123");
      expect(config.headers[HEADER_SAP_JWT_TOKEN]).toBeUndefined();
      expect(config.url).toBe("https://target.example.com/mcp/stream/http");
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledTimes(1);
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledWith("btp-cloud");
      expect(mockBtpAuthBroker.getConnectionConfig).toHaveBeenCalledWith("btp-cloud");
    });
  });

  describe("proxyRequest", () => {
    it("should successfully proxy request with both tokens", async () => {
      testLogger.info("Test: should successfully proxy request with both tokens");
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
      testLogger.info("Test: should handle errors and return error response");
      
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: "btp-cloud",
        reason: "Test",
      };

      testLogger.debug("Routing decision", { routingDecision });

      const request: ProxyRequest = {
        method: "tools/list",
        params: {},
        id: 1,
        jsonrpc: "2.0",
      };

      testLogger.debug("Request", { request });

      const mockError = new Error("Network error");
      mockBtpAuthBroker.getToken.mockResolvedValue("btp-token-123");
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({ serviceUrl: "https://target.example.com", authorizationToken: "" });
      mockAxiosInstance.request.mockRejectedValue(mockError);

      testLogger.debug("Mock error setup", { 
        error: {
          message: mockError.message,
          name: mockError.name,
          stack: mockError.stack?.split('\n').slice(0, 3)
        }
      });

      testLogger.debug("Calling proxy.proxyRequest", {
        method: "proxyRequest",
        parameters: {
          request,
          routingDecision,
          originalHeaders: {}
        }
      });

      const response = await proxy.proxyRequest(request, routingDecision, {});

      testLogger.debug("Error response received", { 
        response: {
          jsonrpc: response.jsonrpc,
          id: response.id,
          hasError: !!response.error,
          hasResult: !!response.result,
          error: response.error ? {
            code: response.error.code,
            message: response.error.message,
            data: response.error.data
          } : null
        },
        expectedError: {
          shouldExist: true,
          shouldContainMessage: "Network error"
        }
      });

      testLogger.debug("Mock calls after error", {
        getToken: {
          called: mockBtpAuthBroker.getToken.mock.calls.length > 0,
          calls: mockBtpAuthBroker.getToken.mock.calls
        },
        getConnectionConfig: {
          called: mockBtpAuthBroker.getConnectionConfig.mock.calls.length > 0,
          calls: mockBtpAuthBroker.getConnectionConfig.mock.calls
        },
        axiosRequest: {
          called: mockAxiosInstance.request.mock.calls.length > 0,
          rejected: true,
          error: mockError.message
        }
      });

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

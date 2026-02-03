/**
 * Unit tests for cloudLlmHubProxy
 */

import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import {
  HEADER_AUTHORIZATION,
  HEADER_SAP_CLIENT,
} from '@mcp-abap-adt/interfaces';
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import {
  CloudLlmHubProxy,
  type ProxyRequest,
  type ProxyResponse,
} from '../../proxy/cloudLlmHubProxy.js';
import {
  type RoutingDecision,
  RoutingStrategy,
} from '../../router/headerAnalyzer.js';
import { getPackageLogger, testLogger } from '../helpers/testLogger.js';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock AuthBroker
jest.mock('@mcp-abap-adt/auth-broker');

// Mock getPlatformStores to avoid creating real stores in tests
jest.mock('../../lib/stores.js', () => ({
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
jest.mock('@mcp-abap-adt/auth-providers', () => ({
  ClientCredentialsProvider: jest.fn(),
}));

describe('CloudLlmHubProxy', () => {
  let proxy: CloudLlmHubProxy;
  let mockBtpAuthBroker: jest.Mocked<AuthBroker>;
  let mockAxiosInstance: jest.Mocked<AxiosInstance>;

  beforeEach(() => {
    testLogger?.debug('Setting up CloudLlmHubProxy test');

    // Reset mocks
    jest.clearAllMocks();

    // Create mock BTP AuthBroker (for XSUAA/BTP destinations)
    mockBtpAuthBroker = {
      getToken: jest.fn(),
      getConnectionConfig: jest.fn(),
    } as any;

    // Mock AuthBroker constructor
    (AuthBroker as jest.MockedClass<typeof AuthBroker>).mockImplementation(
      (_stores: any, browser?: string, logger?: any) => {
        testLogger?.debug(`Creating mock AuthBroker with browser=${browser}`, {
          browser,
          hasLogger: !!logger,
        });
        return mockBtpAuthBroker as any;
      },
    );

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

    // Create proxy instance with BTP auth broker only
    proxy = new CloudLlmHubProxy(mockBtpAuthBroker, {
      maxRetries: 2,
      retryDelay: 100,
      requestTimeout: 5000,
    });
  });

  describe('buildProxyRequest', () => {
    it('should require btpDestination and add Authorization header', async () => {
      testLogger?.info(
        'Test: should require btpDestination and add Authorization header',
      );

      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: 'btp-cloud',
        reason: 'Test',
      };

      const request = { method: 'tools/list' };
      const originalHeaders = {};

      const mockToken = 'btp-token-123';
      const mockConnectionConfig = {
        serviceUrl: 'https://target.example.com',
        authorizationToken: '',
      };

      mockBtpAuthBroker.getToken.mockResolvedValue(mockToken);
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue(
        mockConnectionConfig,
      );

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        request,
        routingDecision,
        originalHeaders,
      );

      expect(config.headers.Authorization).toBe('Bearer btp-token-123');
      expect(config.url).toBe('https://target.example.com/mcp/stream/http');
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledWith('btp-cloud');
      expect(mockBtpAuthBroker.getConnectionConfig).toHaveBeenCalledWith(
        'btp-cloud',
      );
    });

    it('should get URL from BTP destination service key', async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: 'btp-cloud',
        reason: 'Test',
      };

      mockBtpAuthBroker.getToken.mockResolvedValue('btp-token-123');
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({
        serviceUrl: 'https://target.example.com',
        authorizationToken: '',
      });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: 'tools/list' },
        routingDecision,
        {},
      );

      expect(config.url).toBe('https://target.example.com/mcp/stream/http');
      expect(config.method).toBe('POST');
      expect(config.headers.Authorization).toBe('Bearer btp-token-123');
      expect(mockBtpAuthBroker.getConnectionConfig).toHaveBeenCalledWith(
        'btp-cloud',
      );
    });

    it('should handle base URL with trailing slash', async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: 'btp-cloud',
        reason: 'Test',
      };

      mockBtpAuthBroker.getToken.mockResolvedValue('btp-token-123');
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({
        serviceUrl: 'https://target.example.com/',
        authorizationToken: '',
      });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: 'tools/list' },
        routingDecision,
        {},
      );

      expect(config.url).toBe('https://target.example.com/mcp/stream/http');
      expect(config.headers.Authorization).toBe('Bearer btp-token-123');
    });

    it('should preserve SAP client header from original request', async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: 'btp-cloud',
        reason: 'Test',
      };

      const originalHeaders = {
        [HEADER_SAP_CLIENT]: '100',
      };

      mockBtpAuthBroker.getToken.mockResolvedValue('btp-token-123');
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({
        serviceUrl: 'https://target.example.com',
        authorizationToken: '',
      });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: 'tools/list' },
        routingDecision,
        originalHeaders,
      );

      expect(config.headers[HEADER_SAP_CLIENT]).toBe('100');
    });

    it('should throw error if btpDestination is missing and no mcpUrl', async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        reason: 'Test',
      };

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);

      await expect(
        buildProxyRequest({ method: 'tools/list' }, routingDecision, {}),
      ).rejects.toThrow('Cannot determine MCP server URL');
    });

    it('should work without btpDestination when mcpUrl is provided', async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        mcpUrl: 'https://local.example.com/mcp/stream/http',
        reason: 'Test',
      };

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: 'tools/list' },
        routingDecision,
        {},
      );

      expect(config.url).toBe('https://local.example.com/mcp/stream/http');
      expect(config.headers[HEADER_AUTHORIZATION]).toBeUndefined();
    });

    it('should work with only btpDestination (no additional headers)', async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: 'btp-cloud',
        reason: 'Test',
      };

      mockBtpAuthBroker.getToken.mockResolvedValue('btp-token-123');
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({
        serviceUrl: 'https://target.example.com',
        authorizationToken: '',
      });

      const buildProxyRequest = (proxy as any).buildProxyRequest.bind(proxy);
      const config = await buildProxyRequest(
        { method: 'tools/list' },
        routingDecision,
        {},
      );

      expect(config.headers[HEADER_AUTHORIZATION]).toBe('Bearer btp-token-123');
      expect(config.url).toBe('https://target.example.com/mcp/stream/http');
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledTimes(1);
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledWith('btp-cloud');
      expect(mockBtpAuthBroker.getConnectionConfig).toHaveBeenCalledWith(
        'btp-cloud',
      );
    });
  });

  describe('proxyRequest', () => {
    it('should successfully proxy request with BTP token', async () => {
      testLogger?.info(
        'Test: should successfully proxy request with BTP token',
      );
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: 'btp-cloud',
        reason: 'Test',
      };

      const request: ProxyRequest = {
        method: 'tools/list',
        params: {},
        id: 1,
        jsonrpc: '2.0',
      };

      const mockResponse: AxiosResponse<ProxyResponse> = {
        data: {
          jsonrpc: '2.0',
          id: 1,
          result: { tools: [] },
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockBtpAuthBroker.getToken.mockResolvedValue('btp-token-123');
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({
        serviceUrl: 'https://target.example.com',
        authorizationToken: '',
      });

      mockAxiosInstance.request.mockResolvedValue(mockResponse);

      const response = await proxy.proxyRequest(request, routingDecision, {});

      expect(response.result).toEqual({ tools: [] });
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledWith('btp-cloud');
      expect(mockAxiosInstance.request).toHaveBeenCalled();
    });

    it('should handle errors and return error response', async () => {
      testLogger?.info('Test: should handle errors and return error response');

      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: 'btp-cloud',
        reason: 'Test',
      };

      const request: ProxyRequest = {
        method: 'tools/list',
        params: {},
        id: 1,
        jsonrpc: '2.0',
      };

      const mockError = new Error('Network error');
      mockBtpAuthBroker.getToken.mockResolvedValue('btp-token-123');
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({
        serviceUrl: 'https://target.example.com',
        authorizationToken: '',
      });
      mockAxiosInstance.request.mockRejectedValue(mockError);

      const response = await proxy.proxyRequest(request, routingDecision, {});

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32000);
      expect(response.error?.message).toContain('Network error');
    });

    it('should cache tokens for BTP destination', async () => {
      const routingDecision: RoutingDecision = {
        strategy: RoutingStrategy.PROXY,
        btpDestination: 'btp-cloud',
        reason: 'Test',
      };

      const mockResponse: AxiosResponse<ProxyResponse> = {
        data: { jsonrpc: '2.0', id: 1, result: {} },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {} as any,
      };

      mockBtpAuthBroker.getToken.mockResolvedValue('btp-token-123');
      mockBtpAuthBroker.getConnectionConfig.mockResolvedValue({
        serviceUrl: 'https://target.example.com',
        authorizationToken: '',
      });

      mockAxiosInstance.request.mockResolvedValue(mockResponse);

      // First request
      await proxy.proxyRequest(
        { method: 'tools/list', id: 1 },
        routingDecision,
        {},
      );

      // Second request - should use cached token
      await proxy.proxyRequest(
        { method: 'tools/list', id: 2 },
        routingDecision,
        {},
      );

      // getToken should be called once (cached for second request)
      expect(mockBtpAuthBroker.getToken).toHaveBeenCalledTimes(1);
    });
  });
});

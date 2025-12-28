/**
 * Unit tests for requestInterceptor
 */

import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import {
  HEADER_AUTHORIZATION,
  HEADER_BTP_DESTINATION,
  HEADER_MCP_DESTINATION,
  HEADER_MCP_URL,
  HEADER_SAP_DESTINATION_SERVICE,
  HEADER_SAP_JWT_TOKEN,
  HEADER_SAP_PASSWORD,
  HEADER_SAP_REFRESH_TOKEN,
  HEADER_SAP_UAA_CLIENT_SECRET,
} from '@mcp-abap-adt/interfaces';
import {
  interceptRequest,
  requiresSapConfig,
  sanitizeHeadersForLogging,
} from '../../router/requestInterceptor.js';
import { testLogger } from '../helpers/testLogger.js';

describe('requestInterceptor', () => {
  describe('interceptRequest', () => {
    let mockReq: Partial<IncomingMessage>;

    beforeEach(() => {
      testLogger?.debug('Setting up requestInterceptor test');

      const mockSocket = {
        remoteAddress: '127.0.0.1',
        remotePort: 12345,
      } as Socket;

      mockReq = {
        method: 'POST',
        url: '/mcp/stream/http',
        headers: {
          [HEADER_BTP_DESTINATION]: 'btp-cloud',
          [HEADER_MCP_DESTINATION]: 'sap-abap',
          'content-type': 'application/json',
        },
        socket: mockSocket,
      };
    });

    it('should extract method and URL from request', () => {
      testLogger?.info('Test: should extract method and URL from request');

      testLogger?.info('Input request object - raw HTTP request from client', {
        method: mockReq.method,
        url: mockReq.url,
        headers: {
          all: mockReq.headers,
          keys: Object.keys(mockReq.headers || {}),
          values: Object.entries(mockReq.headers || {}).map(([k, v]) => ({
            key: k,
            value: v,
          })),
        },
        socket: {
          remoteAddress: mockReq.socket?.remoteAddress,
          remotePort: mockReq.socket?.remotePort,
          explanation: 'Used to generate clientId',
        },
      });

      testLogger?.info(
        'Calling interceptRequest - will extract and process request data',
        {
          function: 'interceptRequest',
          willExtract: [
            'method from request.method',
            'URL from request.url',
            'headers from request.headers',
            'clientId from socket address',
          ],
        },
      );

      const intercepted = interceptRequest(mockReq as IncomingMessage);

      testLogger?.info('Intercepted request result - processed request data', {
        intercepted: {
          method: intercepted.method,
          url: intercepted.url,
          headers: intercepted.headers,
          clientId: intercepted.clientId,
          hasRoutingDecision: !!intercepted.routingDecision,
        },
        expected: {
          method: 'POST',
          url: '/mcp/stream/http',
        },
        matches: {
          method: intercepted.method === 'POST',
          url: intercepted.url === '/mcp/stream/http',
        },
        extractedData: {
          methodExtracted: intercepted.method,
          urlExtracted: intercepted.url,
          headerCount: intercepted.headers
            ? Object.keys(intercepted.headers).length
            : 0,
          clientIdGenerated: !!intercepted.clientId,
        },
      });

      expect(intercepted.method).toBe('POST');
      expect(intercepted.url).toBe('/mcp/stream/http');
    });

    it('should extract headers from request', () => {
      testLogger?.info('Test: should extract headers from request');

      testLogger?.debug('Input request object', {
        method: mockReq.method,
        url: mockReq.url,
        headers: {
          all: mockReq.headers,
          btpDestination: mockReq.headers?.[HEADER_BTP_DESTINATION],
          mcpDestination: mockReq.headers?.[HEADER_MCP_DESTINATION],
          contentType: mockReq.headers?.['content-type'],
          headerKeys: Object.keys(mockReq.headers || {}),
        },
      });

      testLogger?.debug('Calling interceptRequest', {
        function: 'interceptRequest',
        parameter: {
          method: mockReq.method,
          url: mockReq.url,
          hasHeaders: !!mockReq.headers,
          headerCount: mockReq.headers
            ? Object.keys(mockReq.headers).length
            : 0,
        },
      });

      const intercepted = interceptRequest(mockReq as IncomingMessage);

      testLogger?.debug('Intercepted result object', {
        intercepted: {
          method: intercepted.method,
          url: intercepted.url,
          headers: {
            btpDestination: intercepted.headers[HEADER_BTP_DESTINATION],
            mcpDestination: intercepted.headers[HEADER_MCP_DESTINATION],
            allKeys: Object.keys(intercepted.headers || {}),
          },
          hasRoutingDecision: !!intercepted.routingDecision,
        },
        expected: {
          btpDestination: 'btp-cloud',
          mcpDestination: 'sap-abap',
        },
        matches: {
          btpDestination:
            intercepted.headers[HEADER_BTP_DESTINATION] === 'btp-cloud',
          mcpDestination:
            intercepted.headers[HEADER_MCP_DESTINATION] === 'sap-abap',
        },
      });

      expect(intercepted.headers[HEADER_BTP_DESTINATION]).toBe('btp-cloud');
      expect(intercepted.headers[HEADER_MCP_DESTINATION]).toBe('sap-abap');
    });

    it('should pass config overrides to header analyzer', () => {
      testLogger?.info('Test: should pass config overrides to header analyzer');

      const configOverrides = {
        btpDestination: 'cli-btp',
        mcpDestination: 'cli-mcp',
      };

      testLogger?.debug('Input parameters', {
        request: {
          method: mockReq.method,
          url: mockReq.url,
          headers: mockReq.headers,
        },
        body: undefined,
        configOverrides: {
          btpDestination: configOverrides.btpDestination,
          mcpDestination: configOverrides.mcpDestination,
          allKeys: Object.keys(configOverrides),
        },
        originalHeaders: {
          btpDestination: mockReq.headers?.[HEADER_BTP_DESTINATION],
          mcpDestination: mockReq.headers?.[HEADER_MCP_DESTINATION],
        },
        expectedBehavior:
          'Config overrides should take precedence over headers',
      });

      testLogger?.debug('Calling interceptRequest with overrides', {
        function: 'interceptRequest',
        parameters: {
          request: mockReq,
          body: undefined,
          configOverrides,
        },
      });

      const intercepted = interceptRequest(
        mockReq as IncomingMessage,
        undefined,
        configOverrides,
      );

      testLogger?.debug('Intercepted result with routing decision', {
        intercepted: {
          method: intercepted.method,
          url: intercepted.url,
          routingDecision: intercepted.routingDecision
            ? {
                strategy: intercepted.routingDecision.strategy,
                btpDestination: intercepted.routingDecision.btpDestination,
                mcpDestination: intercepted.routingDecision.mcpDestination,
                reason: intercepted.routingDecision.reason,
              }
            : null,
        },
        expected: {
          btpDestination: 'cli-btp',
          mcpDestination: 'cli-mcp',
        },
        matches: {
          btpDestination:
            intercepted.routingDecision.btpDestination === 'cli-btp',
          mcpDestination:
            intercepted.routingDecision.mcpDestination === 'cli-mcp',
          overridesApplied:
            intercepted.routingDecision.btpDestination !==
            mockReq.headers?.[HEADER_BTP_DESTINATION],
        },
      });

      expect(intercepted.routingDecision.btpDestination).toBe('cli-btp');
      expect(intercepted.routingDecision.mcpDestination).toBe('cli-mcp');
    });

    it('should include body if provided', () => {
      testLogger?.info('Test: should include body if provided');

      const body = { method: 'tools/list', params: {} };
      testLogger?.debug('Request body', body);

      const intercepted = interceptRequest(mockReq as IncomingMessage, body);

      testLogger?.debug('Intercepted body', {
        hasBody: !!intercepted.body,
        bodyKeys: intercepted.body ? Object.keys(intercepted.body) : [],
      });

      expect(intercepted.body).toEqual(body);
    });

    it('should extract session ID from x-session-id header', () => {
      mockReq.headers!['x-session-id'] = 'session-123';
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.sessionId).toBe('session-123');
    });

    it('should extract session ID from mcp-session-id header', () => {
      mockReq.headers!['mcp-session-id'] = 'mcp-session-456';
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.sessionId).toBe('mcp-session-456');
    });

    it('should extract session ID from x-mcp-session-id header', () => {
      mockReq.headers!['x-mcp-session-id'] = 'x-mcp-session-789';
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.sessionId).toBe('x-mcp-session-789');
    });

    it('should generate clientId from socket address', () => {
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.clientId).toBe('127.0.0.1:12345');
    });

    it('should include routing decision from analyzeHeaders', () => {
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.routingDecision).toBeDefined();
      expect(intercepted.routingDecision.strategy).toBeDefined();
      expect(intercepted.routingDecision.btpDestination).toBe('btp-cloud');
    });

    it('should default method to GET if not provided', () => {
      delete mockReq.method;
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.method).toBe('GET');
    });

    it('should default URL to / if not provided', () => {
      delete mockReq.url;
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.url).toBe('/');
    });
  });

  describe('requiresSapConfig', () => {
    it('should return true for tools/call method', () => {
      const body = { method: 'tools/call', params: {} };
      expect(requiresSapConfig(body)).toBe(true);
    });

    it('should return false for other methods', () => {
      const body = { method: 'tools/list', params: {} };
      expect(requiresSapConfig(body)).toBe(false);
    });

    it('should return false for non-object body', () => {
      expect(requiresSapConfig(null)).toBe(false);
      expect(requiresSapConfig(undefined)).toBe(false);
      expect(requiresSapConfig('string')).toBe(false);
      expect(requiresSapConfig(123)).toBe(false);
    });

    it('should return false for object without method', () => {
      const body = { params: {} };
      expect(requiresSapConfig(body)).toBe(false);
    });
  });

  describe('sanitizeHeadersForLogging', () => {
    it('should redact sensitive headers', () => {
      const headers = {
        [HEADER_AUTHORIZATION]: 'Bearer token123',
        [HEADER_SAP_JWT_TOKEN]: 'jwt-token',
        [HEADER_SAP_REFRESH_TOKEN]: 'refresh-token',
        [HEADER_SAP_PASSWORD]: 'password123',
        [HEADER_SAP_UAA_CLIENT_SECRET]: 'secret123',
        [HEADER_MCP_URL]: 'https://example.com',
        'content-type': 'application/json',
      };

      const sanitized = sanitizeHeadersForLogging(headers);

      expect(sanitized[HEADER_AUTHORIZATION]).toBe('[REDACTED]');
      expect(sanitized[HEADER_SAP_JWT_TOKEN]).toBe('[REDACTED]');
      expect(sanitized[HEADER_SAP_REFRESH_TOKEN]).toBe('[REDACTED]');
      expect(sanitized[HEADER_SAP_PASSWORD]).toBe('[REDACTED]');
      expect(sanitized[HEADER_SAP_UAA_CLIENT_SECRET]).toBe('[REDACTED]');
    });

    it('should preserve non-sensitive headers', () => {
      const headers = {
        [HEADER_MCP_URL]: 'https://example.com',
        'content-type': 'application/json',
        [HEADER_SAP_DESTINATION_SERVICE]: 'sk',
      };

      const sanitized = sanitizeHeadersForLogging(headers);

      expect(sanitized[HEADER_MCP_URL]).toBe('https://example.com');
      expect(sanitized['content-type']).toBe('application/json');
      expect(sanitized[HEADER_SAP_DESTINATION_SERVICE]).toBe('sk');
    });

    it('should handle array values by joining', () => {
      const headers = {
        [HEADER_MCP_URL]: ['https://example.com', 'https://other.com'],
        'content-type': 'application/json',
      };

      const sanitized = sanitizeHeadersForLogging(headers);

      expect(sanitized[HEADER_MCP_URL]).toBe(
        'https://example.com, https://other.com',
      );
    });

    it('should handle undefined values', () => {
      const headers = {
        [HEADER_MCP_URL]: undefined,
        'content-type': 'application/json',
      };

      const sanitized = sanitizeHeadersForLogging(headers);

      expect(sanitized[HEADER_MCP_URL]).toBe('');
      expect(sanitized['content-type']).toBe('application/json');
    });

    it('should be case-insensitive for sensitive headers', () => {
      const headers = {
        Authorization: 'Bearer token123',
        'X-SAP-PASSWORD': 'password123',
      };

      const sanitized = sanitizeHeadersForLogging(headers);

      expect(sanitized.Authorization).toBe('[REDACTED]');
      expect(sanitized['X-SAP-PASSWORD']).toBe('[REDACTED]');
    });
  });
});

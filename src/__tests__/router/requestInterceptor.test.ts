/**
 * Unit tests for requestInterceptor
 */

import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import {
  HEADER_AUTHORIZATION,
  HEADER_BTP_DESTINATION,
  HEADER_MCP_URL,
  HEADER_SAP_DESTINATION_SERVICE,
  HEADER_SAP_JWT_TOKEN,
  HEADER_SAP_PASSWORD,
  HEADER_SAP_REFRESH_TOKEN,
  HEADER_SAP_UAA_CLIENT_SECRET,
} from '@mcp-abap-adt/interfaces';
import {
  interceptRequest,
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
          'content-type': 'application/json',
        },
        socket: mockSocket,
      };
    });

    it('should extract method and URL from request', () => {
      testLogger?.info('Test: should extract method and URL from request');

      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.method).toBe('POST');
      expect(intercepted.url).toBe('/mcp/stream/http');
    });

    it('should extract headers from request', () => {
      testLogger?.info('Test: should extract headers from request');

      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.headers[HEADER_BTP_DESTINATION]).toBe('btp-cloud');
    });

    it('should pass config overrides to header analyzer', () => {
      testLogger?.info('Test: should pass config overrides to header analyzer');

      const configOverrides = {
        btpDestination: 'cli-btp',
      };

      const intercepted = interceptRequest(
        mockReq as IncomingMessage,
        undefined,
        configOverrides,
      );

      expect(intercepted.routingDecision.btpDestination).toBe('cli-btp');
    });

    it('should include body if provided', () => {
      testLogger?.info('Test: should include body if provided');

      const body = { method: 'tools/list', params: {} };

      const intercepted = interceptRequest(mockReq as IncomingMessage, body);

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

/**
 * Unit tests for headerAnalyzer
 */

import type { IncomingHttpHeaders } from 'node:http';
import {
  HEADER_BTP_DESTINATION,
  HEADER_MCP_URL,
} from '@mcp-abap-adt/interfaces';
import {
  analyzeHeaders,
  RoutingStrategy,
  shouldProxy,
} from '../../router/headerAnalyzer.js';
import { testLogger } from '../helpers/testLogger.js';

describe('headerAnalyzer', () => {
  describe('analyzeHeaders', () => {
    it('should return PROXY strategy when x-btp-destination is present', () => {
      testLogger?.info(
        'Test: should return PROXY strategy when x-btp-destination is present',
      );

      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: 'btp-cloud',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe('btp-cloud');
      expect(decision.reason).toContain(
        'Proxying to MCP server from BTP destination',
      );
    });

    it('should extract btp-destination from x-btp-destination header', () => {
      testLogger?.info(
        'Test: should extract btp-destination from x-btp-destination header',
      );

      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: 'btp-cloud',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe('btp-cloud');
    });

    it('should use --btp command line override over header', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: 'header-value',
      };

      const decision = analyzeHeaders(headers, {
        btpDestination: 'cli-override',
      });

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe('cli-override');
    });

    it('should return PASSTHROUGH when no headers in request, even with config overrides', () => {
      const headers: IncomingHttpHeaders = {};

      const decision = analyzeHeaders(headers, {
        btpDestination: 'cli-value',
      });

      // If no proxy headers in the actual request, pass through without modifications
      expect(decision.strategy).toBe(RoutingStrategy.PASSTHROUGH);
      expect(decision.reason).toContain('No proxy headers found in request');
    });

    it('should return PASSTHROUGH if no destination headers are provided', () => {
      const headers: IncomingHttpHeaders = {};

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PASSTHROUGH);
      expect(decision.reason).toContain('No proxy headers found');
    });

    it('should return PROXY when x-mcp-url is provided (local testing mode)', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_MCP_URL]: 'https://example.com/mcp/stream/http',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpUrl).toBe('https://example.com/mcp/stream/http');
      expect(decision.reason).toContain('local testing mode');
    });

    it('should work with only x-btp-destination', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: 'btp-cloud',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe('btp-cloud');
    });

    it('should trim whitespace from x-btp-destination', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: '  btp-cloud  ',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe('btp-cloud');
    });

    it('should handle array values in x-btp-destination (use first value)', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_MCP_URL]: 'https://example.com/mcp/stream/http',
        [HEADER_BTP_DESTINATION]: ['btp-cloud', 'other'],
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe('btp-cloud');
    });
  });

  describe('shouldProxy', () => {
    it('should return true when x-btp-destination is present', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: 'btp-cloud',
      };

      expect(shouldProxy(headers)).toBe(true);
    });

    it('should return false when no destination headers are provided', () => {
      const headers: IncomingHttpHeaders = {};

      expect(shouldProxy(headers)).toBe(false);
    });

    it('should return true when x-mcp-url is provided', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_MCP_URL]: 'https://example.com/mcp/stream/http',
      };

      expect(shouldProxy(headers)).toBe(true);
    });
  });
});

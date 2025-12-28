/**
 * Unit tests for headerAnalyzer
 */

import type { IncomingHttpHeaders } from 'node:http';
import {
  HEADER_BTP_DESTINATION,
  HEADER_MCP_DESTINATION,
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
        [HEADER_MCP_DESTINATION]: 'sap-abap',
      };

      testLogger?.info(
        'Input headers object - HTTP headers from incoming request',
        {
          headers: {
            [HEADER_BTP_DESTINATION]: headers[HEADER_BTP_DESTINATION],
            [HEADER_MCP_DESTINATION]: headers[HEADER_MCP_DESTINATION],
            all: headers,
          },
          headerKeys: Object.keys(headers),
          headerValues: Object.entries(headers).map(([k, v]) => ({
            key: k,
            value: v,
          })),
          explanation:
            'Headers contain destination information for routing decision',
        },
      );

      testLogger?.info(
        'Calling analyzeHeaders - will analyze headers to determine routing strategy',
        {
          function: 'analyzeHeaders',
          willCheck: [
            'x-btp-destination header for BTP destination',
            'x-mcp-destination header for MCP/ABAP destination',
            'Determine if PROXY or PASSTHROUGH strategy',
          ],
        },
      );

      const decision = analyzeHeaders(headers);

      testLogger?.info(
        'Routing decision result - strategy determined from headers',
        {
          decision: {
            strategy: decision.strategy,
            btpDestination: decision.btpDestination,
            mcpDestination: decision.mcpDestination,
            reason: decision.reason,
          },
          expected: {
            strategy: RoutingStrategy.PROXY,
            btpDestination: 'btp-cloud',
            mcpDestination: 'sap-abap',
          },
          matches: {
            strategy: decision.strategy === RoutingStrategy.PROXY,
            btpDestination: decision.btpDestination === 'btp-cloud',
            mcpDestination: decision.mcpDestination === 'sap-abap',
          },
          extractedFromHeaders: {
            btpDestination:
              decision.btpDestination === headers[HEADER_BTP_DESTINATION],
            mcpDestination:
              decision.mcpDestination === headers[HEADER_MCP_DESTINATION],
          },
          explanation:
            'PROXY strategy means request will be forwarded to MCP server using retrieved tokens',
        },
      );

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe('btp-cloud');
      expect(decision.mcpDestination).toBe('sap-abap');
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

      testLogger?.debug('Input headers', {
        btpDestination: headers[HEADER_BTP_DESTINATION],
      });

      const decision = analyzeHeaders(headers);

      testLogger?.debug('Extracted destination', {
        strategy: decision.strategy,
        btpDestination: decision.btpDestination,
      });

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

    it('should use --mcp command line override over header', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: 'btp-cloud',
        [HEADER_MCP_DESTINATION]: 'header-value',
      };

      const decision = analyzeHeaders(headers, {
        mcpDestination: 'cli-override',
      });

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe('cli-override');
    });

    it('should return PASSTHROUGH when no headers in request, even with config overrides', () => {
      const headers: IncomingHttpHeaders = {};

      const decision = analyzeHeaders(headers, {
        btpDestination: 'cli-value',
        mcpDestination: 'cli-mcp',
      });

      // If no proxy headers in the actual request, pass through without modifications
      // Config overrides are only used when headers are present in the request
      expect(decision.strategy).toBe(RoutingStrategy.PASSTHROUGH);
      expect(decision.reason).toContain('No proxy headers found in request');
    });

    it('should return PASSTHROUGH if no destination headers are provided', () => {
      const headers: IncomingHttpHeaders = {};

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PASSTHROUGH);
      expect(decision.reason).toContain('No proxy headers found');
    });

    it('should extract mcp-destination from x-mcp-destination header', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: 'btp-cloud',
        [HEADER_MCP_DESTINATION]: 'sap-abap',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe('sap-abap');
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

    it('should work with only x-mcp-destination (local testing mode)', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_MCP_DESTINATION]: 'sap-abap',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe('sap-abap');
      expect(decision.btpDestination).toBeUndefined();
      expect(decision.reason).toContain('local testing mode');
    });

    it('should work with only x-btp-destination (mcp destination optional)', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: 'btp-cloud',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe('btp-cloud');
      expect(decision.mcpDestination).toBeUndefined();
    });

    it('should trim whitespace from x-btp-destination', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: '  btp-cloud  ',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe('btp-cloud');
    });

    it('should trim whitespace from x-mcp-destination', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: 'btp-cloud',
        [HEADER_MCP_DESTINATION]: '  sap-abap  ',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe('sap-abap');
    });

    it('should return PROXY when only x-mcp-destination is provided (no BTP required)', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_MCP_DESTINATION]: 'sap-abap',
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe('sap-abap');
      expect(decision.btpDestination).toBeUndefined();
      expect(decision.reason).toContain('local testing mode');
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

    it('should handle array values in x-mcp-destination (use first value)', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_BTP_DESTINATION]: 'btp-cloud',
        [HEADER_MCP_DESTINATION]: ['sap-abap', 'other'],
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe('sap-abap');
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

    it('should return true when x-mcp-destination is provided', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_MCP_DESTINATION]: 'sap-abap',
      };

      expect(shouldProxy(headers)).toBe(true);
    });

    it('should return true when x-mcp-url is provided', () => {
      const headers: IncomingHttpHeaders = {
        [HEADER_MCP_URL]: 'https://example.com/mcp/stream/http',
      };

      expect(shouldProxy(headers)).toBe(true);
    });
  });
});

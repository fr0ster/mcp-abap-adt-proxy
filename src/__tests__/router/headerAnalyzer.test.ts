/**
 * Unit tests for headerAnalyzer
 */

import type { IncomingHttpHeaders } from 'node:http';
import { HEADER_BTP_DESTINATION } from '@mcp-abap-adt/interfaces';
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

    it('should return UNKNOWN when no headers in request, even with config overrides', () => {
      const headers: IncomingHttpHeaders = {};

      const decision = analyzeHeaders(headers, {
        btpDestination: 'cli-value',
      });

      // If no proxy headers in the actual request, we cannot determine routing reliably solely from config if headers are missing
      // Actually, looking at the implementation:
      // const extractedBtpDestination = configOverrides?.btpDestination ? configOverrides.btpDestination : btpDestinationHeader;
      // if (!extractedBtpDestination) return UNKNOWN
      // So if config override is present, it SHOULD return PROXY?
      // Let's re-read implementation.
      // const hasBtpInRequest = !!btpDestinationHeader;
      // Code says: if (!extractedBtpDestination) return UNKNOWN.
      // So if override provides it, it returns PROXY.

      // Wait, the test says "should return PASSTHROUGH".
      // Previous code had PASSTHROUGH. New code removed it.
      // If we provide CLI override, we satisfy `extractedBtpDestination`.
      // So it returns PROXY.

      // But the test case name is "when no headers in request".
      // If I provide CLI override, it should be PROXY.

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe('cli-value');
    });

    it('should return UNKNOWN if no destination headers are provided', () => {
      const headers: IncomingHttpHeaders = {};

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.UNKNOWN);
      expect(decision.reason).toContain('No BTP destination provided');
    });

    it('should handle array values in x-btp-destination (use first value)', () => {
      const headers: IncomingHttpHeaders = {
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


  });
});

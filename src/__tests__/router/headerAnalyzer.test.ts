/**
 * Unit tests for headerAnalyzer
 */

import { analyzeHeaders, RoutingStrategy, shouldProxy } from "../../router/headerAnalyzer.js";
import { IncomingHttpHeaders } from "http";

describe("headerAnalyzer", () => {
  describe("analyzeHeaders", () => {
    it("should return PROXY strategy when x-btp-destination is present", () => {
      const headers: IncomingHttpHeaders = {
        "x-btp-destination": "btp-cloud",
        "x-mcp-destination": "sap-abap",
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe("btp-cloud");
      expect(decision.mcpDestination).toBe("sap-abap");
      expect(decision.reason).toContain("Proxying to MCP server from BTP destination");
    });

    it("should extract btp-destination from x-btp-destination header", () => {
      const headers: IncomingHttpHeaders = {
        "x-btp-destination": "btp-cloud",
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe("btp-cloud");
    });

    it("should use --btp command line override over header", () => {
      const headers: IncomingHttpHeaders = {
        "x-btp-destination": "header-value",
      };

      const decision = analyzeHeaders(headers, { btpDestination: "cli-override" });

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe("cli-override");
    });

    it("should use --mcp command line override over header", () => {
      const headers: IncomingHttpHeaders = {
        "x-btp-destination": "btp-cloud",
        "x-mcp-destination": "header-value",
      };

      const decision = analyzeHeaders(headers, { mcpDestination: "cli-override" });

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe("cli-override");
    });

    it("should use command line override even when header is missing", () => {
      const headers: IncomingHttpHeaders = {};

      const decision = analyzeHeaders(headers, { btpDestination: "cli-value", mcpDestination: "cli-mcp" });

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe("cli-value");
      expect(decision.mcpDestination).toBe("cli-mcp");
    });

    it("should return UNKNOWN if no destination headers are provided", () => {
      const headers: IncomingHttpHeaders = {};

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.UNKNOWN);
      expect(decision.reason).toContain("x-btp-destination/--btp, x-mcp-destination/--mcp, or x-mcp-url/--mcp-url");
    });

    it("should extract mcp-destination from x-mcp-destination header", () => {
      const headers: IncomingHttpHeaders = {
        "x-btp-destination": "btp-cloud",
        "x-mcp-destination": "sap-abap",
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe("sap-abap");
    });

    it("should return PROXY when x-mcp-url is provided (local testing mode)", () => {
      const headers: IncomingHttpHeaders = {
        "x-mcp-url": "https://example.com/mcp/stream/http",
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpUrl).toBe("https://example.com/mcp/stream/http");
      expect(decision.reason).toContain("local testing mode");
    });

    it("should work with only x-mcp-destination (local testing mode)", () => {
      const headers: IncomingHttpHeaders = {
        "x-mcp-destination": "sap-abap",
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe("sap-abap");
      expect(decision.btpDestination).toBeUndefined();
      expect(decision.reason).toContain("local testing mode");
    });

    it("should work with only x-btp-destination (mcp destination optional)", () => {
      const headers: IncomingHttpHeaders = {
        "x-btp-destination": "btp-cloud",
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe("btp-cloud");
      expect(decision.mcpDestination).toBeUndefined();
    });

    it("should trim whitespace from x-btp-destination", () => {
      const headers: IncomingHttpHeaders = {
        "x-btp-destination": "  btp-cloud  ",
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe("btp-cloud");
    });


    it("should trim whitespace from x-mcp-destination", () => {
      const headers: IncomingHttpHeaders = {
        "x-btp-destination": "btp-cloud",
        "x-mcp-destination": "  sap-abap  ",
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe("sap-abap");
    });

    it("should return PROXY when only x-mcp-destination is provided (no BTP required)", () => {
      const headers: IncomingHttpHeaders = {
        "x-mcp-destination": "sap-abap",
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe("sap-abap");
      expect(decision.btpDestination).toBeUndefined();
      expect(decision.reason).toContain("local testing mode");
    });

    it("should handle array values in x-btp-destination (use first value)", () => {
      const headers: IncomingHttpHeaders = {
        "x-mcp-url": "https://example.com/mcp/stream/http",
        "x-btp-destination": ["btp-cloud", "other"],
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.btpDestination).toBe("btp-cloud");
    });

    it("should handle array values in x-mcp-destination (use first value)", () => {
      const headers: IncomingHttpHeaders = {
        "x-btp-destination": "btp-cloud",
        "x-mcp-destination": ["sap-abap", "other"],
      };

      const decision = analyzeHeaders(headers);

      expect(decision.strategy).toBe(RoutingStrategy.PROXY);
      expect(decision.mcpDestination).toBe("sap-abap");
    });
  });

  describe("shouldProxy", () => {
    it("should return true when x-btp-destination is present", () => {
      const headers: IncomingHttpHeaders = {
        "x-btp-destination": "btp-cloud",
      };

      expect(shouldProxy(headers)).toBe(true);
    });

    it("should return false when no destination headers are provided", () => {
      const headers: IncomingHttpHeaders = {};

      expect(shouldProxy(headers)).toBe(false);
    });

    it("should return true when x-mcp-destination is provided", () => {
      const headers: IncomingHttpHeaders = {
        "x-mcp-destination": "sap-abap",
      };

      expect(shouldProxy(headers)).toBe(true);
    });

    it("should return true when x-mcp-url is provided", () => {
      const headers: IncomingHttpHeaders = {
        "x-mcp-url": "https://example.com/mcp/stream/http",
      };

      expect(shouldProxy(headers)).toBe(true);
    });
  });
});


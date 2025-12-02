/**
 * Unit tests for requestInterceptor
 */

import { interceptRequest, requiresSapConfig, sanitizeHeadersForLogging } from "../../router/requestInterceptor.js";
import { IncomingMessage } from "http";
import { Socket } from "net";

describe("requestInterceptor", () => {
  describe("interceptRequest", () => {
    let mockReq: Partial<IncomingMessage>;

    beforeEach(() => {
      const mockSocket = {
        remoteAddress: "127.0.0.1",
        remotePort: 12345,
      } as Socket;

      mockReq = {
        method: "POST",
        url: "/mcp/stream/http",
        headers: {
          "x-btp-destination": "btp-cloud",
          "x-mcp-destination": "sap-abap",
          "content-type": "application/json",
        },
        socket: mockSocket,
      };
    });

    it("should extract method and URL from request", () => {
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.method).toBe("POST");
      expect(intercepted.url).toBe("/mcp/stream/http");
    });

    it("should extract headers from request", () => {
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.headers["x-btp-destination"]).toBe("btp-cloud");
      expect(intercepted.headers["x-mcp-destination"]).toBe("sap-abap");
    });

    it("should pass config overrides to header analyzer", () => {
      const configOverrides = { btpDestination: "cli-btp", mcpDestination: "cli-mcp" };
      const intercepted = interceptRequest(mockReq as IncomingMessage, undefined, configOverrides);

      expect(intercepted.routingDecision.btpDestination).toBe("cli-btp");
      expect(intercepted.routingDecision.mcpDestination).toBe("cli-mcp");
    });

    it("should include body if provided", () => {
      const body = { method: "tools/list", params: {} };
      const intercepted = interceptRequest(mockReq as IncomingMessage, body);

      expect(intercepted.body).toEqual(body);
    });

    it("should extract session ID from x-session-id header", () => {
      mockReq.headers!["x-session-id"] = "session-123";
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.sessionId).toBe("session-123");
    });

    it("should extract session ID from mcp-session-id header", () => {
      mockReq.headers!["mcp-session-id"] = "mcp-session-456";
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.sessionId).toBe("mcp-session-456");
    });

    it("should extract session ID from x-mcp-session-id header", () => {
      mockReq.headers!["x-mcp-session-id"] = "x-mcp-session-789";
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.sessionId).toBe("x-mcp-session-789");
    });

    it("should generate clientId from socket address", () => {
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.clientId).toBe("127.0.0.1:12345");
    });

    it("should include routing decision from analyzeHeaders", () => {
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.routingDecision).toBeDefined();
      expect(intercepted.routingDecision.strategy).toBeDefined();
      expect(intercepted.routingDecision.btpDestination).toBe("btp-cloud");
    });

    it("should default method to GET if not provided", () => {
      delete mockReq.method;
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.method).toBe("GET");
    });

    it("should default URL to / if not provided", () => {
      delete mockReq.url;
      const intercepted = interceptRequest(mockReq as IncomingMessage);

      expect(intercepted.url).toBe("/");
    });
  });

  describe("requiresSapConfig", () => {
    it("should return true for tools/call method", () => {
      const body = { method: "tools/call", params: {} };
      expect(requiresSapConfig(body)).toBe(true);
    });

    it("should return false for other methods", () => {
      const body = { method: "tools/list", params: {} };
      expect(requiresSapConfig(body)).toBe(false);
    });

    it("should return false for non-object body", () => {
      expect(requiresSapConfig(null)).toBe(false);
      expect(requiresSapConfig(undefined)).toBe(false);
      expect(requiresSapConfig("string")).toBe(false);
      expect(requiresSapConfig(123)).toBe(false);
    });

    it("should return false for object without method", () => {
      const body = { params: {} };
      expect(requiresSapConfig(body)).toBe(false);
    });
  });

  describe("sanitizeHeadersForLogging", () => {
    it("should redact sensitive headers", () => {
      const headers = {
        "authorization": "Bearer token123",
        "x-sap-jwt-token": "jwt-token",
        "x-sap-refresh-token": "refresh-token",
        "x-sap-password": "password123",
        "x-sap-uaa-client-secret": "secret123",
        "x-mcp-url": "https://example.com",
        "content-type": "application/json",
      };

      const sanitized = sanitizeHeadersForLogging(headers);

      expect(sanitized["authorization"]).toBe("[REDACTED]");
      expect(sanitized["x-sap-jwt-token"]).toBe("[REDACTED]");
      expect(sanitized["x-sap-refresh-token"]).toBe("[REDACTED]");
      expect(sanitized["x-sap-password"]).toBe("[REDACTED]");
      expect(sanitized["x-sap-uaa-client-secret"]).toBe("[REDACTED]");
    });

    it("should preserve non-sensitive headers", () => {
      const headers = {
        "x-mcp-url": "https://example.com",
        "content-type": "application/json",
        "x-sap-destination": "sk",
      };

      const sanitized = sanitizeHeadersForLogging(headers);

      expect(sanitized["x-mcp-url"]).toBe("https://example.com");
      expect(sanitized["content-type"]).toBe("application/json");
      expect(sanitized["x-sap-destination"]).toBe("sk");
    });

    it("should handle array values by joining", () => {
      const headers = {
        "x-mcp-url": ["https://example.com", "https://other.com"],
        "content-type": "application/json",
      };

      const sanitized = sanitizeHeadersForLogging(headers);

      expect(sanitized["x-mcp-url"]).toBe("https://example.com, https://other.com");
    });

    it("should handle undefined values", () => {
      const headers = {
        "x-mcp-url": undefined,
        "content-type": "application/json",
      };

      const sanitized = sanitizeHeadersForLogging(headers);

      expect(sanitized["x-mcp-url"]).toBe("");
      expect(sanitized["content-type"]).toBe("application/json");
    });

    it("should be case-insensitive for sensitive headers", () => {
      const headers = {
        "Authorization": "Bearer token123",
        "X-SAP-PASSWORD": "password123",
      };

      const sanitized = sanitizeHeadersForLogging(headers);

      expect(sanitized["Authorization"]).toBe("[REDACTED]");
      expect(sanitized["X-SAP-PASSWORD"]).toBe("[REDACTED]");
    });
  });
});


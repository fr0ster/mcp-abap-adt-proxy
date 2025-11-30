#!/usr/bin/env node

/**
 * MCP ABAP ADT Proxy Server
 * 
 * Proxies local MCP requests to cloud-llm-hub with JWT authentication.
 * Routes requests based on authentication headers:
 * - x-sap-destination: "S4HANA_E19" -> Direct to cloud
 * - x-sap-auth-type: "basic" -> Local handling
 * - x-sap-destination: "sk" -> Proxy to cloud-llm-hub with JWT
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer, Server as HttpServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { parseTransportConfig, TransportConfig } from "./lib/transportConfig.js";
import { loadConfig, validateConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { interceptRequest, requiresSapConfig, sanitizeHeadersForLogging } from "./router/requestInterceptor.js";
import { RoutingStrategy } from "./router/headerAnalyzer.js";

/**
 * MCP ABAP ADT Proxy Server
 */
export class McpAbapAdtProxyServer {
  private server: McpServer;
  private transportConfig: TransportConfig;
  private config: ReturnType<typeof loadConfig>;
  private httpServer?: HttpServer;

  constructor(transportConfig?: TransportConfig) {
    this.transportConfig = transportConfig || parseTransportConfig();
    this.config = loadConfig();

    // Validate configuration
    if (this.transportConfig.type === "streamable-http" || this.transportConfig.type === "sse") {
      const validation = validateConfig(this.config);
      if (!validation.valid) {
        logger.error("Configuration validation failed", {
          type: "CONFIG_VALIDATION_ERROR",
          errors: validation.errors,
        });
        throw new Error(`Configuration validation failed: ${validation.errors.join(", ")}`);
      }
    }

    this.server = new McpServer(
      {
        name: "@mcp-abap-adt/proxy",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * Setup MCP handlers
   */
  private setupHandlers(): void {
    // Tools are registered using server.registerTool()
    // The server automatically handles initialize and tools/list requests
    // For now, we don't register any tools - routing will be handled in middleware
  }

  /**
   * Run the proxy server
   */
  async run(): Promise<void> {
    if (this.transportConfig.type === "stdio") {
      // Simple stdio setup
      const transport = new StdioServerTransport();
      await this.server.server.connect(transport);
      logger.info("MCP Proxy Server started (stdio transport)");
      return;
    }

    if (this.transportConfig.type === "streamable-http") {
      await this.startHttpServer();
      return;
    }

    if (this.transportConfig.type === "sse") {
      await this.startSseServer();
      return;
    }

    throw new Error(`Unsupported transport type: ${this.transportConfig.type}`);
  }

  /**
   * Start HTTP server with request interception
   */
  private async startHttpServer(): Promise<void> {
    const httpConfig = this.transportConfig;
    
    this.httpServer = createServer(async (req, res) => {
      // Log incoming HTTP request (if debug enabled)
      const debugHttpEnabled = process.env.DEBUG_HTTP_REQUESTS === "true";
      if (debugHttpEnabled) {
        const sanitizedHeaders = sanitizeHeadersForLogging(req.headers);
        logger.info("HTTP Request received", {
          type: "HTTP_REQUEST",
          method: req.method,
          url: req.url,
          headers: sanitizedHeaders,
          remoteAddress: req.socket.remoteAddress,
        });
      }

      // Only handle POST requests
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method not allowed");
        return;
      }

      // Read request body
      let body: any;
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const bodyString = Buffer.concat(chunks).toString("utf-8");
        body = JSON.parse(bodyString);
      } catch (error) {
        logger.error("Failed to parse request body", {
          type: "REQUEST_PARSE_ERROR",
          error: error instanceof Error ? error.message : String(error),
        });
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid request body");
        return;
      }

      // Intercept and analyze request
      const intercepted = interceptRequest(req, body);

      // Log routing decision
      logger.debug("Routing decision made", {
        type: "ROUTING_DECISION",
        strategy: intercepted.routingDecision.strategy,
        reason: intercepted.routingDecision.reason,
        requiresSapConfig: requiresSapConfig(body),
      });

      // Handle request based on routing strategy
      // For Phase 2, we just log the decision - actual routing will be in Phase 3-5
      try {
        // Create transport for this request
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless mode
          enableJsonResponse: httpConfig.enableJsonResponse,
          allowedHosts: httpConfig.allowedHosts,
          allowedOrigins: httpConfig.allowedOrigins,
          enableDnsRebindingProtection: httpConfig.enableDnsRebindingProtection,
        });

        // Close transport when response closes
        res.on("close", () => {
          transport.close();
        });

        // Connect server to transport
        await this.server.server.connect(transport);

        // Handle the request through MCP server
        // The server will process the request and send response through transport
        logger.debug("Request processed", {
          type: "REQUEST_PROCESSED",
          strategy: intercepted.routingDecision.strategy,
        });
      } catch (error) {
        logger.error("Failed to process request", {
          type: "REQUEST_PROCESS_ERROR",
          error: error instanceof Error ? error.message : String(error),
          strategy: intercepted.routingDecision.strategy,
        });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal server error");
        }
      }
    });

    const port = httpConfig.port || 3001;
    const host = httpConfig.host || "0.0.0.0";

    return new Promise((resolve, reject) => {
      this.httpServer!.listen(port, host, () => {
        logger.info("MCP Proxy Server started (HTTP transport)", {
          type: "SERVER_STARTED",
          transport: "streamable-http",
          host,
          port,
        });
        resolve();
      });

      this.httpServer!.on("error", (error) => {
        logger.error("Failed to start HTTP server", {
          type: "SERVER_START_ERROR",
          error: error.message,
        });
        reject(error);
      });
    });
  }

  /**
   * Start SSE server
   */
  private async startSseServer(): Promise<void> {
    // TODO: Implement SSE server in future phase
    throw new Error("SSE transport not yet implemented");
  }

  /**
   * Shutdown server
   */
  async shutdown(): Promise<void> {
    try {
      await this.server.close();
    } catch (error) {
      logger.error("Failed to close MCP server", {
        type: "SERVER_SHUTDOWN_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => {
          logger.info("HTTP server closed");
          resolve();
        });
      });
    }
  }
}

// Export for use in bin script
export default McpAbapAdtProxyServer;


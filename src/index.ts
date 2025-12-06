#!/usr/bin/env node

/**
 * MCP ABAP ADT Proxy Server
 * 
 * Proxies local MCP requests to MCP servers with optional JWT authentication.
 * Routes requests based on authentication headers:
 * - x-btp-destination (or --btp): BTP Cloud authorization with JWT token
 * - x-mcp-destination (or --mcp): SAP ABAP connection configuration
 * 
 * Supports two modes:
 * 1. BTP authentication mode: Requires x-btp-destination or --btp parameter
 * 2. Local testing mode: Works with only x-mcp-destination or --mcp parameter (no BTP authentication)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer, Server as HttpServer, IncomingMessage, ServerResponse } from "http";
import { parseTransportConfig, TransportConfig } from "./lib/transportConfig.js";
import { loadConfig, validateConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { interceptRequest, requiresSapConfig, sanitizeHeadersForLogging } from "./router/requestInterceptor.js";
import { RoutingStrategy } from "./router/headerAnalyzer.js";
import { createCloudLlmHubProxy, CloudLlmHubProxy } from "./proxy/cloudLlmHubProxy.js";

/**
 * MCP ABAP ADT Proxy Server
 */
export class McpAbapAdtProxyServer {
  private server: McpServer;
  private transportConfig: TransportConfig;
  private config: ReturnType<typeof loadConfig>;
  private httpServer?: HttpServer;
  private cloudLlmHubProxy?: CloudLlmHubProxy;

  constructor(transportConfig?: TransportConfig, configPath?: string) {
    this.transportConfig = transportConfig || parseTransportConfig();
    this.config = loadConfig(configPath);

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
      if (validation.warnings.length > 0) {
        logger.warn("Configuration validation warnings", {
          type: "CONFIG_VALIDATION_WARNINGS",
          warnings: validation.warnings,
        });
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
    // For stdio, we'll intercept requests through server.server message handler
  }

  /**
   * Handle stdio request by proxying to MCP server
   * Supports both BTP authentication mode (--btp) and local testing mode (--mcp without --btp)
   */
  private async handleStdioRequest(method: string, params: any, id: any): Promise<any> {
    // Create fake headers with config overrides (--btp, --mcp, and/or --mcp-url)
    const fakeHeaders: Record<string, string> = {};
    if (this.config.btpDestination) {
      fakeHeaders["x-btp-destination"] = this.config.btpDestination;
    }
    if (this.config.mcpDestination) {
      fakeHeaders["x-mcp-destination"] = this.config.mcpDestination;
    }
    if (this.config.mcpUrl) {
      fakeHeaders["x-mcp-url"] = this.config.mcpUrl;
    }

    // Create routing decision using config overrides
    const configOverrides = {
      btpDestination: this.config.btpDestination,
      mcpDestination: this.config.mcpDestination,
      mcpUrl: this.config.mcpUrl,
    };
    const { analyzeHeaders } = await import("./router/headerAnalyzer.js");
    const routingDecision = analyzeHeaders(fakeHeaders, configOverrides);

    // Check if routing is valid
    if (routingDecision.strategy !== RoutingStrategy.PROXY) {
      logger.error("Routing decision failed for stdio request", {
        type: "STDIO_ROUTING_DECISION_FAILED",
        reason: routingDecision.reason,
      });
      return {
        jsonrpc: "2.0",
        id: id || null,
        error: {
          code: -32602,
          message: routingDecision.reason || "Routing decision failed",
        },
      };
    }

    // Ensure proxy is initialized
    if (!this.cloudLlmHubProxy) {
      const baseUrl = this.config.cloudLlmHubUrl || "https://default.example.com";
      this.cloudLlmHubProxy = await createCloudLlmHubProxy(baseUrl, this.config);
    }

    // Build MCP request
    const mcpRequest = {
      method: method || "",
      params: params || {},
      id: id || null,
      jsonrpc: "2.0",
    };

    // Proxy request to cloud-llm-hub
    try {
      const proxyResponse = await this.cloudLlmHubProxy.proxyRequest(
        mcpRequest,
        routingDecision,
        fakeHeaders
      );
      return proxyResponse;
    } catch (error) {
      logger.error("Failed to proxy stdio request", {
        type: "STDIO_PROXY_ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        jsonrpc: "2.0",
        id: id || null,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  /**
   * Run the proxy server
   */
  async run(): Promise<void> {
    if (this.transportConfig.type === "stdio") {
      // Check if either --btp, --mcp, or --mcp-url parameter is provided (required for stdio)
      if (!this.config.btpDestination && !this.config.mcpDestination && !this.config.mcpUrl) {
        logger.error("Either --btp, --mcp, or --mcp-url parameter is required for stdio transport", {
          type: "STDIO_DESTINATION_REQUIRED",
        });
        throw new Error("Either --btp, --mcp, or --mcp-url parameter is required for stdio transport. Use --btp=<destination> for BTP destination, --mcp=<destination> for MCP destination, or --mcp-url=<url> for direct MCP server URL (local testing).");
      }

      // For stdio, we need to register a proxy tool that forwards all requests
      // Since we can't intercept all requests directly, we'll register a tool
      // that the client can call, which will proxy to cloud-llm-hub
      // Note: This requires the client to know about the proxy tool
      // Alternatively, we could use a custom transport wrapper
      
      // Simple stdio setup - MCP SDK will handle JSON-RPC protocol
      // For tools/call requests, we need to intercept them
      // Since MCP SDK doesn't provide a way to intercept all requests,
      // we'll need to handle this differently
      // For now, we'll just connect and let the SDK handle it
      // The actual proxying will need to be done through registered tools
      
      const transport = new StdioServerTransport();
      await this.server.server.connect(transport);
      logger.info("MCP Proxy Server started (stdio transport)", {
        type: "SERVER_STARTED",
        transport: "stdio",
        btpDestination: this.config.btpDestination,
        mcpDestination: this.config.mcpDestination,
        mcpUrl: this.config.mcpUrl,
        note: "For stdio transport, --btp, --mcp, and/or --mcp-url parameters are used as default destinations",
        mode: this.config.btpDestination ? "BTP authentication" : "Local testing (no BTP authentication)",
      });
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
      // Pass config overrides (--btp, --mcp, and --mcp-url) to header analyzer
      const configOverrides = {
        btpDestination: this.config.btpDestination,
        mcpDestination: this.config.mcpDestination,
        mcpUrl: this.config.mcpUrl,
      };
      const intercepted = interceptRequest(req, body, configOverrides);

      // Check routing decision
      if (intercepted.routingDecision.strategy === RoutingStrategy.UNKNOWN) {
        logger.error("Routing decision failed", {
          type: "ROUTING_DECISION_FAILED",
          reason: intercepted.routingDecision.reason,
        });
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: body?.id || null,
          error: {
            code: -32602,
            message: intercepted.routingDecision.reason,
          },
        }));
        return;
      }

      // Log proxy request
      logger.debug("Proxying request", {
        type: "PROXY_REQUEST",
        btpDestination: intercepted.routingDecision.btpDestination,
        mcpDestination: intercepted.routingDecision.mcpDestination,
        requiresSapConfig: requiresSapConfig(body),
      });

      // Handle proxy request - add JWT and forward to x-mcp-url
      try {
        await this.handleProxyRequest(intercepted, req, res);
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
   * Handle proxy request - add JWT token and forward to MCP server
   */
  private async handleProxyRequest(
    intercepted: ReturnType<typeof interceptRequest>,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const btpDestination = intercepted.routingDecision.btpDestination;
    const mcpDestination = intercepted.routingDecision.mcpDestination;
    const mcpUrl = intercepted.routingDecision.mcpUrl;

    logger.info("Handling proxy request", {
      type: "PROXY_REQUEST",
      btpDestination,
      mcpDestination,
      mcpUrl,
      sessionId: intercepted.sessionId,
      mode: btpDestination ? "BTP authentication" : "Local testing (no BTP authentication)",
    });

    try {
      // Ensure proxy is initialized (URL will be obtained from service key for btpDestination or mcpDestination)
      if (!this.cloudLlmHubProxy) {
        // Use default base URL from config as fallback (actual URL comes from service key)
        const baseUrl = this.config.cloudLlmHubUrl || "https://default.example.com";
        this.cloudLlmHubProxy = await createCloudLlmHubProxy(baseUrl, this.config);
      }

      // Build MCP request from intercepted request
      const mcpRequest = {
        method: intercepted.body?.method || "",
        params: intercepted.body?.params || {},
        id: intercepted.body?.id || null,
        jsonrpc: intercepted.body?.jsonrpc || "2.0",
      };

      // Proxy request to cloud-llm-hub
      const proxyResponse = await this.cloudLlmHubProxy.proxyRequest(
        mcpRequest,
        intercepted.routingDecision,
        intercepted.headers
      );

      // Send response back to client
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(proxyResponse));

      logger.debug("Cloud-llm-hub proxy request completed", {
        type: "CLOUD_LLM_HUB_PROXY_COMPLETED",
        hasResult: !!proxyResponse.result,
        hasError: !!proxyResponse.error,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to handle cloud-llm-hub proxy request", {
        type: "CLOUD_LLM_HUB_PROXY_ERROR",
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
      
      // Output error to stderr for user visibility
      process.stderr.write(`[MCP Proxy] ✗ Connection error: ${errorMessage}\n`);
      
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: intercepted.body?.id || null,
          error: {
            code: -32000,
            message: errorMessage,
          },
        }));
      }
    }
  }

  /**
   * Start SSE server
   */
  private async startSseServer(): Promise<void> {
    const sseConfig = this.transportConfig;
    
    const streamPathMap = new Map<string, string>([
      ["/", "/messages"],
      ["/mcp/events", "/mcp/messages"],
      ["/sse", "/messages"],
    ]);
    const streamPaths = Array.from(streamPathMap.keys());
    const postPathSet = new Set(streamPathMap.values());
    postPathSet.add("/messages");
    postPathSet.add("/mcp/messages");

    const httpServer = createServer(async (req, res) => {
      // SSE: Always restrict to local connections only
      const remoteAddress = req.socket.remoteAddress;
      const isLocal = remoteAddress === "127.0.0.1" || 
                     remoteAddress === "::1" || 
                     remoteAddress === "localhost" ||
                     (remoteAddress && remoteAddress.startsWith("127."));
      
      if (!isLocal) {
        logger.warn("SSE: Non-local connection rejected", {
          type: "SSE_NON_LOCAL_REJECTED",
          remoteAddress,
        });
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: SSE transport only accepts local connections");
        return;
      }

      const requestUrl = req.url ? new URL(req.url, `http://${req.headers.host ?? `${sseConfig.host}:${sseConfig.port}`}`) : undefined;
      let pathname = requestUrl?.pathname ?? "/";
      if (pathname.length > 1 && pathname.endsWith("/")) {
        pathname = pathname.slice(0, -1);
      }

      // Apply config overrides (--btp, --mcp, and --mcp-url) to headers if not present
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
          headers[key] = Array.isArray(value) ? value[0] : value;
        }
      }
      
      // Add config overrides if not present in headers
      if (this.config.btpDestination && !headers["x-btp-destination"]) {
        headers["x-btp-destination"] = this.config.btpDestination;
      }
      if (this.config.mcpDestination && !headers["x-mcp-destination"]) {
        headers["x-mcp-destination"] = this.config.mcpDestination;
      }
      if (this.config.mcpUrl && !headers["x-mcp-url"]) {
        headers["x-mcp-url"] = this.config.mcpUrl;
      }

      logger.debug("SSE request received", {
        type: "SSE_HTTP_REQUEST",
        method: req.method,
        pathname,
        originalUrl: req.url,
      });

      // GET /sse, /mcp/events, or / - establish SSE connection
      if (req.method === "GET" && streamPathMap.has(pathname)) {
        const postEndpoint = streamPathMap.get(pathname) ?? "/messages";

        logger.debug("SSE client connecting", {
          type: "SSE_CLIENT_CONNECTING",
          pathname,
          postEndpoint,
        });

        // Create new McpServer instance for this session
        const sessionServer = new McpServer(
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

        // Create SSE transport
        const transport = new SSEServerTransport(postEndpoint, res, {
          allowedHosts: sseConfig.allowedHosts,
          allowedOrigins: sseConfig.allowedOrigins,
          enableDnsRebindingProtection: sseConfig.enableDnsRebindingProtection,
        });

        const sessionId = transport.sessionId;
        logger.info("New SSE session created", {
          type: "SSE_SESSION_CREATED",
          sessionId,
          pathname,
        });

        // Connect transport to server
        try {
          await sessionServer.server.connect(transport);
          logger.info("SSE transport connected", {
            type: "SSE_CONNECTION_READY",
            sessionId,
            pathname,
            postEndpoint,
          });
        } catch (error) {
          logger.error("Failed to connect SSE transport", {
            type: "SSE_CONNECT_ERROR",
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
          if (!res.headersSent) {
            res.writeHead(500).end("Internal Server Error");
          } else {
            res.end();
          }
          return;
        }

        // Cleanup on connection close
        res.on("close", () => {
          logger.info("SSE connection closed", {
            type: "SSE_CONNECTION_CLOSED",
            sessionId,
            pathname,
          });
          sessionServer.server.close();
        });

        transport.onerror = (error) => {
          logger.error("SSE transport error", {
            type: "SSE_TRANSPORT_ERROR",
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        };
        return;
      }

      // POST /messages or /mcp/messages - handle client messages
      if (req.method === "POST" && postPathSet.has(pathname)) {
        // Extract sessionId from query string or header
        let sessionId: string | undefined;
        if (requestUrl) {
          sessionId = requestUrl.searchParams.get("sessionId") || undefined;
        }
        if (!sessionId) {
          sessionId = req.headers["x-session-id"] as string | undefined;
        }

        logger.debug("SSE POST request received", {
          type: "SSE_POST_REQUEST",
          sessionId,
          pathname,
        });

        if (!sessionId) {
          logger.error("Missing sessionId in SSE POST request", {
            type: "SSE_MISSING_SESSION_ID",
            pathname,
          });
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Missing sessionId",
              },
              id: null,
            })
          );
          return;
        }

        // Read request body
        let body: any;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          if (chunks.length > 0) {
            const bodyString = Buffer.concat(chunks).toString("utf-8");
            body = JSON.parse(bodyString);
          }
        } catch (error) {
          logger.error("Failed to parse SSE POST request body", {
            type: "SSE_POST_PARSE_ERROR",
            error: error instanceof Error ? error.message : String(error),
          });
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32700,
                message: "Parse error",
              },
              id: null,
            })
          );
          return;
        }

        // Intercept and analyze request with config overrides
        const configOverrides = {
          btpDestination: this.config.btpDestination,
          mcpDestination: this.config.mcpDestination,
          mcpUrl: this.config.mcpUrl,
        };
        const intercepted = interceptRequest(req, body, configOverrides);

        // Check routing decision
        if (intercepted.routingDecision.strategy === RoutingStrategy.UNKNOWN) {
          logger.error("Routing decision failed for SSE POST", {
            type: "SSE_POST_ROUTING_FAILED",
            reason: intercepted.routingDecision.reason,
          });
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body?.id || null,
              error: {
                code: -32602,
                message: intercepted.routingDecision.reason,
              },
            })
          );
          return;
        }

        // Handle proxy request
        try {
          await this.handleProxyRequest(intercepted, req, res);
        } catch (error) {
          logger.error("Failed to process SSE POST request", {
            type: "SSE_POST_PROCESS_ERROR",
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              id: body?.id || null,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : "Unknown error",
              },
            }));
          }
        }
        return;
      }

      // Unknown path or method
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    const port = sseConfig.port || 3002;
    const host = sseConfig.host || "0.0.0.0";

    return new Promise((resolve, reject) => {
      httpServer.listen(port, host, () => {
        logger.info("MCP Proxy Server started (SSE transport)", {
          type: "SERVER_STARTED",
          transport: "sse",
          host,
          port,
        });
        this.httpServer = httpServer;
        resolve();
      });

      httpServer.on("error", (error) => {
        logger.error("Failed to start SSE server", {
          type: "SERVER_START_ERROR",
          error: error.message,
        });
        reject(error);
      });
    });
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

// Auto-start server when run directly (unless MCP_SKIP_AUTO_START is set)
if (process.env.MCP_SKIP_AUTO_START !== "true") {
  const server = new McpAbapAdtProxyServer();
  server.run().catch((error) => {
    logger.error("Fatal error while running MCP proxy server", {
      type: "SERVER_FATAL_ERROR",
      error: error instanceof Error ? error.message : String(error),
    });
    // Always write to stderr (safe even in stdio mode)
    process.stderr.write(`[MCP Proxy] ✗ Fatal error: ${error instanceof Error ? error.message : String(error)}\n`);
    // On Windows, add a small delay before exit to allow error message to be visible
    if (process.platform === 'win32') {
      setTimeout(() => process.exit(1), 100);
    } else {
      process.exit(1);
    }
  });
}


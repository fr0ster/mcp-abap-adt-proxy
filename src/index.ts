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
import { AuthBroker } from "@mcp-abap-adt/auth-broker";
import { parseTransportConfig, TransportConfig } from "./lib/transportConfig.js";
import { loadConfig, validateConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { interceptRequest, requiresSapConfig, sanitizeHeadersForLogging } from "./router/requestInterceptor.js";
import { RoutingStrategy } from "./router/headerAnalyzer.js";
import { createDirectCloudConfig, getDirectCloudConnection } from "./router/directCloudRouter.js";
import { createLocalBasicConfig, getLocalBasicConnection } from "./router/localBasicRouter.js";
import { createCloudLlmHubProxy, CloudLlmHubProxy } from "./proxy/cloudLlmHubProxy.js";
import { getPlatformStores } from "./lib/stores.js";

/**
 * MCP ABAP ADT Proxy Server
 */
export class McpAbapAdtProxyServer {
  private server: McpServer;
  private transportConfig: TransportConfig;
  private config: ReturnType<typeof loadConfig>;
  private httpServer?: HttpServer;
  private cloudLlmHubProxy?: CloudLlmHubProxy;

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
      try {
        // Phase 3: Direct Cloud Routing
        if (intercepted.routingDecision.strategy === RoutingStrategy.DIRECT_CLOUD) {
          await this.handleDirectCloudRequest(intercepted, req, res);
          return;
        }

        // Phase 4: Local Basic Auth
        if (intercepted.routingDecision.strategy === RoutingStrategy.LOCAL_BASIC) {
          await this.handleLocalBasicRequest(intercepted, req, res);
          return;
        }

        // Phase 5: Proxy to cloud-llm-hub
        if (intercepted.routingDecision.strategy === RoutingStrategy.PROXY_CLOUD_LLM_HUB) {
          await this.handleCloudLlmHubProxyRequest(intercepted, req, res);
          return;
        }

        // Unknown strategy
        logger.warn("Unknown routing strategy", {
          type: "UNKNOWN_ROUTING_STRATEGY",
          strategy: intercepted.routingDecision.strategy,
        });
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Unknown routing strategy");
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
   * Handle direct cloud request (Phase 3)
   */
  private async handleDirectCloudRequest(
    intercepted: ReturnType<typeof interceptRequest>,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    logger.info("Handling direct cloud request", {
      type: "DIRECT_CLOUD_REQUEST",
      destination: intercepted.routingDecision.destination,
      sessionId: intercepted.sessionId,
    });

    try {
      // Create direct cloud config from routing decision
      const cloudConfig = createDirectCloudConfig(
        intercepted.routingDecision,
        intercepted.headers
      );

      if (!cloudConfig) {
        logger.error("Failed to create direct cloud config", {
          type: "DIRECT_CLOUD_CONFIG_ERROR",
        });
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Failed to create cloud connection configuration");
        return;
      }

      // Get or create AuthBroker for destination if needed
      let authBroker: AuthBroker | undefined;
      if (cloudConfig.destination) {
        try {
          const { serviceKeyStore, sessionStore } = await getPlatformStores();
          authBroker = new AuthBroker(
            {
              serviceKeyStore,
              sessionStore,
            },
            "system"
          );
        } catch (error) {
          logger.warn("Failed to create AuthBroker, continuing without it", {
            type: "AUTH_BROKER_CREATE_WARNING",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Get direct cloud connection
      const sessionId = intercepted.sessionId || randomUUID();
      const connection = await getDirectCloudConnection(
        sessionId,
        cloudConfig,
        authBroker
      );

      logger.debug("Direct cloud connection established", {
        type: "DIRECT_CLOUD_CONNECTION_ESTABLISHED",
        destination: cloudConfig.destination,
        sapUrl: cloudConfig.sapUrl,
      });

      // For Phase 3, we just log that connection is established
      // Actual MCP tool handling will be implemented when we register tools
      // For now, return a placeholder response
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: intercepted.body?.id || null,
        result: {
          message: "Direct cloud connection established (Phase 3 - routing only)",
          destination: cloudConfig.destination,
          strategy: "direct-cloud",
        },
      }));
    } catch (error) {
      logger.error("Failed to handle direct cloud request", {
        type: "DIRECT_CLOUD_REQUEST_ERROR",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Failed to establish direct cloud connection");
      }
    }
  }

  /**
   * Handle local basic auth request (Phase 4)
   */
  private async handleLocalBasicRequest(
    intercepted: ReturnType<typeof interceptRequest>,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    logger.info("Handling local basic auth request", {
      type: "LOCAL_BASIC_REQUEST",
      sessionId: intercepted.sessionId,
    });

    try {
      // Create local basic config from routing decision
      const basicConfig = createLocalBasicConfig(
        intercepted.routingDecision,
        intercepted.headers
      );

      if (!basicConfig) {
        logger.error("Failed to create local basic config", {
          type: "LOCAL_BASIC_CONFIG_ERROR",
        });
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Failed to create basic auth configuration");
        return;
      }

      // Get local basic connection
      const sessionId = intercepted.sessionId || randomUUID();
      const connection = await getLocalBasicConnection(sessionId, basicConfig);

      logger.debug("Local basic connection established", {
        type: "LOCAL_BASIC_CONNECTION_ESTABLISHED",
        sapUrl: basicConfig.sapUrl,
      });

      // For Phase 4, we just log that connection is established
      // Actual MCP tool handling will be implemented when we register tools
      // For now, return a placeholder response
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: intercepted.body?.id || null,
        result: {
          message: "Local basic auth connection established (Phase 4 - routing only)",
          strategy: "local-basic",
        },
      }));
    } catch (error) {
      logger.error("Failed to handle local basic request", {
        type: "LOCAL_BASIC_REQUEST_ERROR",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Failed to establish local basic auth connection");
      }
    }
  }

  /**
   * Handle cloud-llm-hub proxy request (Phase 5)
   */
  private async handleCloudLlmHubProxyRequest(
    intercepted: ReturnType<typeof interceptRequest>,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    logger.info("Handling cloud-llm-hub proxy request", {
      type: "CLOUD_LLM_HUB_PROXY_REQUEST",
      destination: intercepted.routingDecision.destination,
      sessionId: intercepted.sessionId,
    });

    try {
      // Ensure cloud-llm-hub proxy is initialized
      if (!this.cloudLlmHubProxy) {
        if (!this.config.cloudLlmHubUrl) {
          logger.error("Cloud LLM Hub URL not configured", {
            type: "CLOUD_LLM_HUB_URL_MISSING",
          });
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Cloud LLM Hub URL not configured");
          return;
        }

        this.cloudLlmHubProxy = await createCloudLlmHubProxy(this.config.cloudLlmHubUrl);
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
      logger.error("Failed to handle cloud-llm-hub proxy request", {
        type: "CLOUD_LLM_HUB_PROXY_ERROR",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: intercepted.body?.id || null,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : "Unknown error",
          },
        }));
      }
    }
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


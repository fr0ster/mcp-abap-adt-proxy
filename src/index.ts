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

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  HEADER_BTP_DESTINATION,
  HEADER_MCP_DESTINATION,
  HEADER_MCP_URL,
} from '@mcp-abap-adt/interfaces';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import axios from 'axios';
import { loadConfig, validateConfig } from './lib/config.js';
import { logger } from './lib/logger.js';
import {
  parseTransportConfig,
  type TransportConfig,
} from './lib/transportConfig.js';
import {
  type CloudLlmHubProxy,
  createCloudLlmHubProxy,
  shouldWriteStderr,
} from './proxy/cloudLlmHubProxy.js';
import { RoutingStrategy } from './router/headerAnalyzer.js';
import {
  interceptRequest,
  requiresSapConfig,
  sanitizeHeadersForLogging,
} from './router/requestInterceptor.js';

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
    if (
      this.transportConfig.type === 'streamable-http' ||
      this.transportConfig.type === 'sse'
    ) {
      const validation = validateConfig(this.config);
      if (!validation.valid) {
        logger?.error('Configuration validation failed', {
          type: 'CONFIG_VALIDATION_ERROR',
          errors: validation.errors,
        });
        throw new Error(
          `Configuration validation failed: ${validation.errors.join(', ')}`,
        );
      }
      if (validation.warnings.length > 0) {
        logger?.warn('Configuration validation warnings', {
          type: 'CONFIG_VALIDATION_WARNINGS',
          warnings: validation.warnings,
        });
      }
    }

    this.server = new McpServer(
      {
        name: '@mcp-abap-adt/proxy',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
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
   * Run the proxy server
   */
  async run(): Promise<void> {
    if (this.transportConfig.type === 'stdio') {
      // Check if either --btp, --mcp, or --mcp-url parameter is provided (required for stdio)
      if (
        !this.config.btpDestination &&
        !this.config.mcpDestination &&
        !this.config.mcpUrl
      ) {
        logger?.error(
          'Either --btp, --mcp, or --mcp-url parameter is required for stdio transport',
          {
            type: 'STDIO_DESTINATION_REQUIRED',
          },
        );
        throw new Error(
          'Either --btp, --mcp, or --mcp-url parameter is required for stdio transport. Use --btp=<destination> for BTP destination, --mcp=<destination> for MCP destination, or --mcp-url=<url> for direct MCP server URL (local testing).',
        );
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
      logger?.info('MCP Proxy Server started (stdio transport)', {
        type: 'SERVER_STARTED',
        transport: 'stdio',
        btpDestination: this.config.btpDestination,
        mcpDestination: this.config.mcpDestination,
        mcpUrl: this.config.mcpUrl,
        note: 'For stdio transport, --btp, --mcp, and/or --mcp-url parameters are used as default destinations',
        mode: this.config.btpDestination
          ? 'BTP authentication'
          : 'Local testing (no BTP authentication)',
      });
      return;
    }

    if (this.transportConfig.type === 'streamable-http') {
      await this.startHttpServer();
      return;
    }

    if (this.transportConfig.type === 'sse') {
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
      // Log incoming HTTP request (always log in DEBUG mode)
      const _debugEnabled =
        process.env.DEBUG === 'true' ||
        process.env.DEBUG_HTTP_REQUESTS === 'true';
      const sanitizedHeaders = sanitizeHeadersForLogging(req.headers);

      logger?.info('=== HTTP REQUEST RECEIVED ===', {
        type: 'HTTP_REQUEST_RECEIVED',
        method: req.method,
        url: req.url,
        headers: sanitizedHeaders,
        remoteAddress: req.socket.remoteAddress,
      });

      // Only handle POST requests
      if (req.method !== 'POST') {
        logger?.warn('Non-POST request rejected', {
          type: 'NON_POST_REQUEST',
          method: req.method,
        });
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method not allowed');
        return;
      }

      // Read request body
      let body: any;
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const bodyString = Buffer.concat(chunks).toString('utf-8');

        logger?.info('=== PARSING REQUEST BODY ===', {
          type: 'REQUEST_BODY_PARSING',
          bodyLength: bodyString.length,
          bodyPreview: bodyString.substring(0, 200),
        });

        body = JSON.parse(bodyString);

        // Sanitize body for logging
        const sanitizedBody: any = {};
        if (body && typeof body === 'object') {
          sanitizedBody.method = body.method;
          sanitizedBody.id = body.id;
          sanitizedBody.jsonrpc = body.jsonrpc;
          if (body.params && typeof body.params === 'object') {
            sanitizedBody.params = {};
            if (
              body.params.arguments &&
              typeof body.params.arguments === 'object'
            ) {
              sanitizedBody.params.arguments = {};
              for (const [key, value] of Object.entries(
                body.params.arguments,
              )) {
                const lowerKey = key.toLowerCase();
                if (
                  lowerKey.includes('password') ||
                  lowerKey.includes('token') ||
                  lowerKey.includes('secret')
                ) {
                  sanitizedBody.params.arguments[key] = '[REDACTED]';
                } else {
                  sanitizedBody.params.arguments[key] = value;
                }
              }
            }
            for (const [key, value] of Object.entries(body.params)) {
              if (key === 'arguments') continue;
              sanitizedBody.params[key] = value;
            }
          }
        }

        logger?.info('=== REQUEST BODY PARSED ===', {
          type: 'REQUEST_BODY_PARSED',
          body: sanitizedBody,
        });
      } catch (error) {
        logger?.error('=== FAILED TO PARSE REQUEST BODY ===', {
          type: 'REQUEST_PARSE_ERROR',
          error: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
        });
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid request body');
        return;
      }

      // Intercept and analyze request
      // Pass config overrides (--btp, --mcp, and --mcp-url) to header analyzer
      const configOverrides = {
        btpDestination: this.config.btpDestination,
        mcpDestination: this.config.mcpDestination,
        mcpUrl: this.config.mcpUrl,
      };

      logger?.info('=== INTERCEPTING REQUEST ===', {
        type: 'REQUEST_INTERCEPTING',
        configOverrides,
      });

      const intercepted = interceptRequest(req, body, configOverrides);

      logger?.info('=== REQUEST INTERCEPTED ===', {
        type: 'REQUEST_INTERCEPTED',
        routingStrategy: intercepted.routingDecision.strategy,
        routingReason: intercepted.routingDecision.reason,
        btpDestination: intercepted.routingDecision.btpDestination,
        mcpDestination: intercepted.routingDecision.mcpDestination,
        mcpUrl: intercepted.routingDecision.mcpUrl,
      });

      // Check routing decision
      if (intercepted.routingDecision.strategy === RoutingStrategy.UNKNOWN) {
        logger?.error('Routing decision failed', {
          type: 'ROUTING_DECISION_FAILED',
          reason: intercepted.routingDecision.reason,
        });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body?.id || null,
            error: {
              code: -32602,
              message: intercepted.routingDecision.reason,
            },
          }),
        );
        return;
      }

      // If no proxy headers, pass through request without modifications
      if (
        intercepted.routingDecision.strategy === RoutingStrategy.PASSTHROUGH
      ) {
        logger?.debug('Passing through request without modifications', {
          type: 'PASSTHROUGH_REQUEST',
          reason: intercepted.routingDecision.reason,
        });
        try {
          await this.handlePassthroughRequest(intercepted, req, res);
        } catch (error) {
          logger?.error('Failed to process passthrough request', {
            type: 'PASSTHROUGH_REQUEST_ERROR',
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal server error');
          }
        }
        return;
      }

      // Log proxy request
      logger?.info('=== PROXYING REQUEST ===', {
        type: 'PROXY_REQUEST_START',
        btpDestination: intercepted.routingDecision.btpDestination,
        mcpDestination: intercepted.routingDecision.mcpDestination,
        requiresSapConfig: requiresSapConfig(body),
      });

      // Handle proxy request - add JWT and forward to x-mcp-url
      try {
        await this.handleProxyRequest(intercepted, req, res);
      } catch (error) {
        logger?.error('Failed to process request', {
          type: 'REQUEST_PROCESS_ERROR',
          error: error instanceof Error ? error.message : String(error),
          strategy: intercepted.routingDecision.strategy,
        });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal server error');
        }
      }
    });

    const port = httpConfig.port || 3001;
    const host = httpConfig.host || '0.0.0.0';

    return new Promise((resolve, reject) => {
      this.httpServer?.listen(port, host, () => {
        logger?.info('MCP Proxy Server started (HTTP transport)', {
          type: 'SERVER_STARTED',
          transport: 'streamable-http',
          host,
          port,
        });
        resolve();
      });

      this.httpServer?.on('error', (error) => {
        logger?.error('Failed to start HTTP server', {
          type: 'SERVER_START_ERROR',
          error: error.message,
        });
        reject(error);
      });
    });
  }

  /**
   * Handle passthrough request - forward request as-is without modifications
   */
  private async handlePassthroughRequest(
    intercepted: ReturnType<typeof interceptRequest>,
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Use mcpUrl from routing decision (from --mcp-url) or cloudLlmHubUrl from config as target URL
    const targetUrl =
      intercepted.routingDecision.mcpUrl || this.config.cloudLlmHubUrl;
    if (!targetUrl) {
      logger?.error(
        'Cannot handle passthrough request: no target URL configured',
        {
          type: 'PASSTHROUGH_NO_URL',
        },
      );
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: intercepted.body?.id || null,
          error: {
            code: -32000,
            message: 'Target URL not configured',
          },
        }),
      );
      return;
    }

    logger?.debug('Forwarding passthrough request', {
      type: 'PASSTHROUGH_FORWARD',
      targetUrl,
      method: intercepted.method,
      url: intercepted.url,
    });

    try {
      // Forward request with original headers and body
      const response = await axios({
        method: intercepted.method || 'POST',
        url: `${targetUrl}${intercepted.url || '/'}`,
        headers: intercepted.headers as Record<string, string>,
        data: intercepted.body,
        validateStatus: () => true, // Accept all status codes
      });

      // Forward response back to client
      res.writeHead(
        response.status,
        response.headers as Record<string, string | string[]>,
      );
      res.end(response.data);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger?.error('Failed to forward passthrough request', {
        type: 'PASSTHROUGH_FORWARD_ERROR',
        error: errorMessage,
      });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: intercepted.body?.id || null,
            error: {
              code: -32000,
              message: errorMessage,
            },
          }),
        );
      }
    }
  }

  /**
   * Handle proxy request - add JWT token and forward to MCP server
   */
  private async handleProxyRequest(
    intercepted: ReturnType<typeof interceptRequest>,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const btpDestination = intercepted.routingDecision.btpDestination;
    const mcpDestination = intercepted.routingDecision.mcpDestination;
    const mcpUrl = intercepted.routingDecision.mcpUrl;

    // Log incoming request details
    const incomingHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(intercepted.headers)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('token') ||
        lowerKey.includes('authorization') ||
        lowerKey.includes('password') ||
        lowerKey.includes('secret')
      ) {
        incomingHeaders[key] = '[REDACTED]';
      } else {
        incomingHeaders[key] = Array.isArray(value)
          ? value.join(', ')
          : value || '';
      }
    }

    const sanitizedBody: any = {};
    if (intercepted.body && typeof intercepted.body === 'object') {
      if (
        intercepted.body.params &&
        typeof intercepted.body.params === 'object'
      ) {
        sanitizedBody.params = {};
        // For tools/call, log arguments
        if (
          intercepted.body.params.arguments &&
          typeof intercepted.body.params.arguments === 'object'
        ) {
          sanitizedBody.params.arguments = {};
          for (const [key, value] of Object.entries(
            intercepted.body.params.arguments,
          )) {
            const lowerKey = key.toLowerCase();
            if (
              lowerKey.includes('password') ||
              lowerKey.includes('token') ||
              lowerKey.includes('secret')
            ) {
              sanitizedBody.params.arguments[key] = '[REDACTED]';
            } else {
              sanitizedBody.params.arguments[key] = value;
            }
          }
        }
        // Log other params
        for (const [key, value] of Object.entries(intercepted.body.params)) {
          if (key === 'arguments') continue;
          sanitizedBody.params[key] = value;
        }
      }
      sanitizedBody.method = intercepted.body.method;
      sanitizedBody.id = intercepted.body.id;
      sanitizedBody.jsonrpc = intercepted.body.jsonrpc;
    }

    logger?.info('=== INCOMING REQUEST ===', {
      type: 'PROXY_REQUEST_INCOMING',
      method: req.method,
      url: req.url,
      btpDestination,
      mcpDestination,
      mcpUrl,
      sessionId: intercepted.sessionId,
      headers: incomingHeaders,
      body: sanitizedBody,
      mode: btpDestination
        ? 'BTP authentication'
        : 'Local testing (no BTP authentication)',
    });

    try {
      // Ensure proxy is initialized (URL will be obtained from service key for btpDestination or mcpDestination)
      if (!this.cloudLlmHubProxy) {
        // Use default base URL from config as fallback (actual URL comes from service key)
        const baseUrl =
          this.config.cloudLlmHubUrl || 'https://default.example.com';
        this.cloudLlmHubProxy = await createCloudLlmHubProxy(
          baseUrl,
          this.config,
        );
      }

      // Build MCP request from intercepted request
      // Note: Use ?? instead of || to preserve falsy values like 0
      const interceptedBodyId = intercepted.body?.id;
      const interceptedBodyIdType = typeof interceptedBodyId;
      const interceptedBodyIdUndefined = interceptedBodyId === undefined;

      logger?.info('=== BEFORE BUILDING MCP REQUEST ===', {
        type: 'BEFORE_BUILD_MCP_REQUEST',
        interceptedBodyId,
        interceptedBodyIdType,
        interceptedBodyIdUndefined,
        interceptedBodyIdNull: interceptedBodyId === null,
        interceptedBodyIdZero: interceptedBodyId === 0,
        interceptedBodyIdFalsy: !interceptedBodyId,
        fullInterceptedBody: JSON.stringify(intercepted.body),
      });

      // Preserve id correctly - 0 is a valid id value
      const mcpRequestId =
        interceptedBodyId !== undefined ? interceptedBodyId : null;

      const mcpRequest = {
        method: intercepted.body?.method ?? '',
        params: intercepted.body?.params ?? {},
        id: mcpRequestId,
        jsonrpc: intercepted.body?.jsonrpc ?? '2.0',
      };

      logger?.info('=== MCP REQUEST BUILT ===', {
        type: 'MCP_REQUEST_BUILT',
        originalId: interceptedBodyId,
        originalIdType: interceptedBodyIdType,
        mcpRequestId: mcpRequest.id,
        mcpRequestIdType: typeof mcpRequest.id,
        mcpRequestIdValue: mcpRequest.id,
        fullMcpRequest: JSON.stringify(mcpRequest),
      });

      logger?.info('=== FORWARDING REQUEST ===', {
        type: 'PROXY_REQUEST_FORWARDING',
        interceptedBodyIdAtForward: intercepted.body?.id,
        interceptedBodyIdTypeAtForward: typeof intercepted.body?.id,
        mcpRequest: {
          method: mcpRequest.method,
          params: sanitizedBody.params,
          id: mcpRequest.id,
          jsonrpc: mcpRequest.jsonrpc,
        },
        routingDecision: {
          btpDestination,
          mcpDestination,
          mcpUrl,
        },
      });

      // Proxy request to cloud-llm-hub
      const proxyResponse = await this.cloudLlmHubProxy.proxyRequest(
        mcpRequest,
        intercepted.routingDecision,
        intercepted.headers,
      );

      // Log response
      const sanitizedResponse: any = {
        jsonrpc: proxyResponse.jsonrpc,
        id: proxyResponse.id,
      };
      if (proxyResponse.result) {
        sanitizedResponse.result = proxyResponse.result;
      }
      if (proxyResponse.error) {
        sanitizedResponse.error = {
          code: proxyResponse.error.code,
          message: proxyResponse.error.message,
          data: proxyResponse.error.data,
        };
      }

      logger?.info('=== RESPONSE FROM MCP SERVER ===', {
        type: 'PROXY_RESPONSE_RECEIVED',
        response: sanitizedResponse,
        hasResult: !!proxyResponse.result,
        hasError: !!proxyResponse.error,
      });

      // Send response back to client
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(proxyResponse));

      logger?.info('=== RESPONSE SENT TO CLIENT ===', {
        type: 'PROXY_RESPONSE_SENT',
        statusCode: 200,
      });

      logger?.debug('Cloud-llm-hub proxy request completed', {
        type: 'CLOUD_LLM_HUB_PROXY_COMPLETED',
        hasResult: !!proxyResponse.result,
        hasError: !!proxyResponse.error,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger?.error('Failed to handle cloud-llm-hub proxy request', {
        type: 'CLOUD_LLM_HUB_PROXY_ERROR',
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Output error to stderr for user visibility (only if verbose mode is enabled)
      if (shouldWriteStderr()) {
        process.stderr.write(
          `[MCP Proxy] ✗ Connection error: ${errorMessage}\n`,
        );
      }

      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: intercepted.body?.id || null,
            error: {
              code: -32000,
              message: errorMessage,
            },
          }),
        );
      }
    }
  }

  /**
   * Start SSE server
   */
  private async startSseServer(): Promise<void> {
    const sseConfig = this.transportConfig;

    const streamPathMap = new Map<string, string>([
      ['/', '/messages'],
      ['/mcp/events', '/mcp/messages'],
      ['/sse', '/messages'],
    ]);
    const _streamPaths = Array.from(streamPathMap.keys());
    const postPathSet = new Set(streamPathMap.values());
    postPathSet.add('/messages');
    postPathSet.add('/mcp/messages');

    const httpServer = createServer(async (req, res) => {
      // SSE: Always restrict to local connections only
      const remoteAddress = req.socket.remoteAddress;
      const isLocal =
        remoteAddress === '127.0.0.1' ||
        remoteAddress === '::1' ||
        remoteAddress === 'localhost' ||
        remoteAddress?.startsWith('127.');

      if (!isLocal) {
        logger?.warn('SSE: Non-local connection rejected', {
          type: 'SSE_NON_LOCAL_REJECTED',
          remoteAddress,
        });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: SSE transport only accepts local connections');
        return;
      }

      const requestUrl = req.url
        ? new URL(
            req.url,
            `http://${req.headers.host ?? `${sseConfig.host}:${sseConfig.port}`}`,
          )
        : undefined;
      let pathname = requestUrl?.pathname ?? '/';
      if (pathname.length > 1 && pathname.endsWith('/')) {
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
      if (this.config.btpDestination && !headers[HEADER_BTP_DESTINATION]) {
        headers[HEADER_BTP_DESTINATION] = this.config.btpDestination;
      }
      if (this.config.mcpDestination && !headers[HEADER_MCP_DESTINATION]) {
        headers[HEADER_MCP_DESTINATION] = this.config.mcpDestination;
      }
      if (this.config.mcpUrl && !headers[HEADER_MCP_URL]) {
        headers[HEADER_MCP_URL] = this.config.mcpUrl;
      }

      logger?.debug('SSE request received', {
        type: 'SSE_HTTP_REQUEST',
        method: req.method,
        pathname,
        originalUrl: req.url,
      });

      // GET /sse, /mcp/events, or / - establish SSE connection
      if (req.method === 'GET' && streamPathMap.has(pathname)) {
        const postEndpoint = streamPathMap.get(pathname) ?? '/messages';

        logger?.debug('SSE client connecting', {
          type: 'SSE_CLIENT_CONNECTING',
          pathname,
          postEndpoint,
        });

        // Create new McpServer instance for this session
        const sessionServer = new McpServer(
          {
            name: '@mcp-abap-adt/proxy',
            version: '0.1.0',
          },
          {
            capabilities: {
              tools: {},
            },
          },
        );

        // Create SSE transport
        const transport = new SSEServerTransport(postEndpoint, res, {
          allowedHosts: sseConfig.allowedHosts,
          allowedOrigins: sseConfig.allowedOrigins,
          enableDnsRebindingProtection: sseConfig.enableDnsRebindingProtection,
        });

        const sessionId = transport.sessionId;
        logger?.info('New SSE session created', {
          type: 'SSE_SESSION_CREATED',
          sessionId,
          pathname,
        });

        // Connect transport to server
        try {
          await sessionServer.server.connect(transport);
          logger?.info('SSE transport connected', {
            type: 'SSE_CONNECTION_READY',
            sessionId,
            pathname,
            postEndpoint,
          });
        } catch (error) {
          logger?.error('Failed to connect SSE transport', {
            type: 'SSE_CONNECT_ERROR',
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
          if (!res.headersSent) {
            res.writeHead(500).end('Internal Server Error');
          } else {
            res.end();
          }
          return;
        }

        // Cleanup on connection close
        res.on('close', () => {
          logger?.info('SSE connection closed', {
            type: 'SSE_CONNECTION_CLOSED',
            sessionId,
            pathname,
          });
          sessionServer.server.close();
        });

        transport.onerror = (error) => {
          logger?.error('SSE transport error', {
            type: 'SSE_TRANSPORT_ERROR',
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        };
        return;
      }

      // POST /messages or /mcp/messages - handle client messages
      if (req.method === 'POST' && postPathSet.has(pathname)) {
        // Extract sessionId from query string or header
        let sessionId: string | undefined;
        if (requestUrl) {
          sessionId = requestUrl.searchParams.get('sessionId') || undefined;
        }
        if (!sessionId) {
          sessionId = req.headers['x-session-id'] as string | undefined;
        }

        logger?.debug('SSE POST request received', {
          type: 'SSE_POST_REQUEST',
          sessionId,
          pathname,
        });

        if (!sessionId) {
          logger?.error('Missing sessionId in SSE POST request', {
            type: 'SSE_MISSING_SESSION_ID',
            pathname,
          });
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Missing sessionId',
              },
              id: null,
            }),
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
            const bodyString = Buffer.concat(chunks).toString('utf-8');
            body = JSON.parse(bodyString);
          }
        } catch (error) {
          logger?.error('Failed to parse SSE POST request body', {
            type: 'SSE_POST_PARSE_ERROR',
            error: error instanceof Error ? error.message : String(error),
          });
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32700,
                message: 'Parse error',
              },
              id: null,
            }),
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
          logger?.error('Routing decision failed for SSE POST', {
            type: 'SSE_POST_ROUTING_FAILED',
            reason: intercepted.routingDecision.reason,
          });
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body?.id || null,
              error: {
                code: -32602,
                message: intercepted.routingDecision.reason,
              },
            }),
          );
          return;
        }

        // If no proxy headers, pass through request without modifications
        if (
          intercepted.routingDecision.strategy === RoutingStrategy.PASSTHROUGH
        ) {
          try {
            await this.handlePassthroughRequest(intercepted, req, res);
          } catch (error) {
            logger?.error('Failed to process SSE passthrough request', {
              type: 'SSE_PASSTHROUGH_PROCESS_ERROR',
              error: error instanceof Error ? error.message : String(error),
            });
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
              res.end('Internal server error');
            }
          }
          return;
        }

        // Handle proxy request
        try {
          await this.handleProxyRequest(intercepted, req, res);
        } catch (error) {
          logger?.error('Failed to process SSE POST request', {
            type: 'SSE_POST_PROCESS_ERROR',
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body?.id || null,
                error: {
                  code: -32000,
                  message:
                    error instanceof Error ? error.message : 'Unknown error',
                },
              }),
            );
          }
        }
        return;
      }

      // Unknown path or method
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    const port = sseConfig.port || 3002;
    const host = sseConfig.host || '0.0.0.0';

    return new Promise((resolve, reject) => {
      httpServer.listen(port, host, () => {
        logger?.info('MCP Proxy Server started (SSE transport)', {
          type: 'SERVER_STARTED',
          transport: 'sse',
          host,
          port,
        });
        this.httpServer = httpServer;
        resolve();
      });

      httpServer.on('error', (error) => {
        logger?.error('Failed to start SSE server', {
          type: 'SERVER_START_ERROR',
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
      logger?.error('Failed to close MCP server', {
        type: 'SERVER_SHUTDOWN_ERROR',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer?.close(() => {
          logger?.info('HTTP server closed');
          resolve();
        });
      });
    }
  }
}

// Export for use in bin script
export default McpAbapAdtProxyServer;

// Auto-start server when run directly (unless MCP_SKIP_AUTO_START is set)
if (process.env.MCP_SKIP_AUTO_START !== 'true') {
  const server = new McpAbapAdtProxyServer();
  server.run().catch((error) => {
    logger?.error('Fatal error while running MCP proxy server', {
      type: 'SERVER_FATAL_ERROR',
      error: error instanceof Error ? error.message : String(error),
    });
    // Always write fatal errors to stderr (even in non-verbose mode, as these are critical)
    // But skip in test environment
    const isTestEnv =
      process.env.NODE_ENV === 'test' ||
      process.env.JEST_WORKER_ID !== undefined ||
      typeof (globalThis as any).jest !== 'undefined';
    if (!isTestEnv) {
      process.stderr.write(
        `[MCP Proxy] ✗ Fatal error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    // On Windows, add a small delay before exit to allow error message to be visible
    if (process.platform === 'win32') {
      setTimeout(() => process.exit(1), 100);
    } else {
      process.exit(1);
    }
  });
}

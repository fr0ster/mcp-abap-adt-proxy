// src/mcp/server.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type ProxyConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { createBtpProxy } from '../proxy/btpProxy.js';
import { ProxySupervisor } from './supervisor.js';
import { createProxyTools, SHUTDOWN_REMINDER } from './tools.js';

/**
 * The MCP mode: a stdio server whose tools start and stop this proxy.
 *
 * Installed as its own small command, `mcp-abap-adt-proxy-mcp`, so a client
 * that wants to MANAGE proxies registers this, while a client that wants to BE
 * proxied still points at `mcp-abap-adt-proxy` as before. The two are different
 * jobs and conflating them would make every plain proxy carry a management
 * surface it never uses.
 */
export function createMcpModeServer(config: ProxyConfig): {
  server: McpServer;
  supervisor: ProxySupervisor;
} {
  const supervisor = new ProxySupervisor({
    // The config a tool loaded is the whole story — destination, target,
    // headers, browser, timeouts. `config` here is only the fallback for
    // anything a proxy config leaves out.
    proxyFor: async (options) =>
      createBtpProxy({ ...config, ...options.config }),
  });

  // Read rather than written down: a version literal here drifts from the one
  // that ships the moment a release bumps package.json and not this file.
  //
  // `__dirname` rather than `import.meta`: the sources are authored as ESM but
  // compiled to CommonJS, where `import.meta` does not exist — and the build
  // says so rather than letting it fail in a client's hands.
  const { version } = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'),
  ) as { version: string };

  const server = new McpServer(
    { name: '@mcp-abap-adt/proxy-mcp', version },
    {
      instructions:
        'Starts and stops local authenticating proxies for SAP BTP ' +
        `destinations. ${SHUTDOWN_REMINDER}`,
    },
  );

  for (const tool of createProxyTools(supervisor)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      // The SDK's callback types are generic over the schema; the tool's own
      // handler is already typed against it.
      tool.handler as never,
    );
  }

  return { server, supervisor };
}

/**
 * Connect over stdio and stay up until the session ends.
 *
 * Every way this process can end stops the proxies first. That is the whole
 * point of running them in this process: a listener that outlives the session
 * that asked for it is a port nobody remembers holding.
 */
export async function runMcpMode(
  config: ProxyConfig = loadConfig(),
): Promise<void> {
  const { server, supervisor } = createMcpModeServer(config);

  let closing = false;
  const closeDown = async (why: string) => {
    if (closing) return;
    closing = true;
    logger?.info('MCP mode shutting down', { type: 'MCP_MODE_SHUTDOWN', why });
    const stopped = await supervisor.stop();
    if (stopped.length > 0) {
      logger?.info('Released proxies on shutdown', {
        type: 'MCP_MODE_SHUTDOWN_RELEASED',
        count: stopped.length,
        ports: stopped.map((s) => s.port),
      });
    }
    await server.close().catch(() => {
      /* already gone */
    });
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void closeDown(signal).finally(() => process.exit(0));
    });
  }
  // The client hanging up is the ordinary case, not an exceptional one.
  process.stdin.on('close', () => {
    void closeDown('stdin closed').finally(() => process.exit(0));
  });

  await server.connect(new StdioServerTransport());
}

// src/mcp/server.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type ProxyConfig } from '../lib/config.js';
import { createBtpProxy } from '../proxy/btpProxy.js';
import { createShutdown } from './shutdown.js';
import { ProxySupervisor, type SupervisorOptions } from './supervisor.js';
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
export interface McpModeDeps {
  /** How a credential is built for a started proxy. */
  proxyFor?: SupervisorOptions['proxyFor'];
}

export function createMcpModeServer(
  _config: ProxyConfig,
  deps: McpModeDeps = {},
): {
  server: McpServer;
  supervisor: ProxySupervisor;
} {
  const supervisor = new ProxySupervisor({
    // The loaded proxy config, unchanged and un-merged.
    //
    // This used to spread a baseline under it, described as "the fallback for
    // anything a proxy config leaves out". It was not a fallback.
    // `applyDefaults` sets EVERY key, so a config saying nothing about headers
    // still arrives carrying `defaultHeaders: undefined` — and spreading that
    // over the baseline erased it. Since the baseline is the documented home of
    // `x-sap-login` / `x-sap-password`, the failure was a request going out
    // with no ABAP credentials and nothing saying so.
    //
    // No fallback is needed: `loadConfig(file)` already overlays the CLI flags
    // this command was given, which is how `--unsafe` reaches every proxy.
    proxyFor: deps.proxyFor ?? ((options) => createBtpProxy(options.config)),
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
 *
 * The ordering, the run-once guard and the deadline live in `createShutdown`,
 * where they are tested. They were inline here, and the exit sat in a
 * `.finally()` after an unbounded await — so anything that hung below produced
 * exactly the process this design exists to avoid.
 */
export async function runMcpMode(
  config: ProxyConfig = loadConfig(),
): Promise<void> {
  const { server, supervisor } = createMcpModeServer(config);

  const shutdown = createShutdown({
    supervisor,
    closeServer: () => server.close(),
    exit: (code) => process.exit(code),
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  // The client hanging up is the ordinary case, not an exceptional one.
  process.stdin.on('close', () => void shutdown('stdin closed'));

  await server.connect(new StdioServerTransport());
}

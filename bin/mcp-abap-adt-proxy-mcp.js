#!/usr/bin/env node

/**
 * MCP ABAP ADT Proxy — management mode.
 *
 * Speaks MCP over stdio and exposes tools that start and stop proxies. This is
 * the command a client registers when it wants to MANAGE proxies; a client that
 * wants to BE proxied still points at `mcp-abap-adt-proxy`.
 *
 * Usage:
 *   mcp-abap-adt-proxy-mcp [--config <file>] [--unsafe]
 */

const path = require('path');
const fs = require('fs');

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    help: args.includes('--help') || args.includes('-h'),
    version: args.includes('--version') || args.includes('-v'),
  };
}

function showHelp() {
  const pkg = require('../package.json');
  console.log(`
MCP ABAP ADT Proxy — management mode v${pkg.version}

Speaks MCP over stdio. Its tools start and stop authenticating proxies; it does
not proxy anything itself.

Usage:
  mcp-abap-adt-proxy-mcp [options]

Tools offered to the client:
  proxy_start    Start a proxy for a BTP destination. Takes a FREE port, so
                 several sessions can run their own without colliding, and
                 returns the URL that was actually bound.
  proxy_stop     Stop a proxy this session started, freeing its port and
                 releasing its credential. Proxies belonging to other sessions
                 are never touched.
  proxy_status   List this session's proxies and any others on this machine.
                 Records whose process has died are pruned when read.

Options:
  --config=<file>, -c     Load configuration from a YAML or JSON file
  --env-file=<path>       Load a .env file for \${VAR} interpolation
  --unsafe                Persist tokens to disk
  --help, -h              Show this help message
  --version, -v           Show version number

Shutting down:
  Every proxy runs in THIS process. Closing the session — or SIGINT, or SIGTERM
  — stops all of them and frees their ports. A proxy nobody has used for 30
  minutes stops itself; that is a backstop, not a substitute for proxy_stop.

Registering it with a client:
  {
    "mcpServers": {
      "abap-proxy": { "command": "mcp-abap-adt-proxy-mcp" }
    }
  }

For more information, see: https://github.com/fr0ster/mcp-abap-adt-proxy
`);
}

function main() {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (args.version) {
    console.log(require('../package.json').version);
    process.exit(0);
  }

  const serverPath = path.resolve(__dirname, '../dist/mcp/cli.js');

  if (!fs.existsSync(serverPath)) {
    process.stderr.write(`[MCP Proxy] ✗ Server not found at: ${serverPath}\n`);
    process.stderr.write(
      `[MCP Proxy]   Make sure to build the project with 'npm run build' first.\n`,
    );
    process.exit(1);
    return;
  }

  // Loaded in THIS process, never spawned — the same rule the proxy launcher
  // follows, and it matters more here: the proxies the tools start are
  // listeners in this process, and a spawned child would be orphaned by any
  // signal this launcher did not forward, still holding their ports.
  require(serverPath);
}

main();

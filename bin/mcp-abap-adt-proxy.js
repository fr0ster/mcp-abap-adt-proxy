#!/usr/bin/env node

/**
 * MCP ABAP ADT Proxy Server Launcher
 *
 * Simple launcher that spawns the main server process.
 *
 * Usage:
 *   mcp-abap-adt-proxy [options]
 *   mcp-abap-adt-proxy --transport=stdio
 *   mcp-abap-adt-proxy --transport=http
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    help: false,
    version: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.version = true;
    }
  }

  return result;
}

// Show help
function showHelp() {
  const pkg = require('../package.json');
  console.log(`
MCP ABAP ADT Proxy Server v${pkg.version}

Usage:
  mcp-abap-adt-proxy [options]

Options:
  --transport=<type>       Transport type: stdio, http, streamable-http, sse
  --http-port=<port>      HTTP server port (default: 3001)
  --sse-port=<port>       SSE server port (default: 3002)
  --http-host=<host>      HTTP server host (default: 0.0.0.0)
  --sse-host=<host>       SSE server host (default: 0.0.0.0)
  --cloud-llm-hub-url     Cloud LLM Hub URL (default: from env CLOUD_LLM_HUB_URL)
  --help, -h              Show this help message
  --version, -v           Show version number

Environment Variables:
  CLOUD_LLM_HUB_URL       Cloud LLM Hub URL
  MCP_HTTP_PORT           HTTP server port (default: 3001)
  MCP_SSE_PORT            SSE server port (default: 3002)
  MCP_HTTP_HOST           HTTP server host (default: 0.0.0.0)
  MCP_SSE_HOST            SSE server host (default: 0.0.0.0)
  MCP_TRANSPORT           Transport type (stdio|http|sse)

Examples:
  mcp-abap-adt-proxy                                    # Use default transport
  mcp-abap-adt-proxy --transport=stdio                  # Use stdio transport
  mcp-abap-adt-proxy --transport=http                   # HTTP mode (port 3001)
  mcp-abap-adt-proxy --transport=http --http-port=8080  # HTTP mode on custom port
  mcp-abap-adt-proxy --transport=sse --sse-port=3002    # SSE mode on port 3002

Transport Modes:
  - stdio (default if stdin is not TTY): For MCP clients like Cline/Cursor
  - http / streamable-http: HTTP server (default if stdin is TTY, port 3001)
  - sse: Server-Sent Events server (port 3002)

For more information, see: https://github.com/fr0ster/mcp-abap-adt-proxy
`);
}

// Show version
function showVersion() {
  const pkg = require('../package.json');
  console.log(pkg.version);
}

// Main launcher logic
function main() {
  const args = parseArgs();

  // Handle --help
  if (args.help) {
    showHelp();
    process.exit(0);
  }

  // Handle --version
  if (args.version) {
    showVersion();
    process.exit(0);
  }

  // Spawn the main server process
  const serverPath = path.resolve(__dirname, '../dist/index.js');

  if (!fs.existsSync(serverPath)) {
    process.stderr.write(`[MCP Proxy] ✗ Server not found at: ${serverPath}\n`);
    process.stderr.write(`[MCP Proxy]   Make sure to build the project with 'npm run build' first.\n`);
    if (process.platform === 'win32') {
      setTimeout(() => process.exit(1), 30000);
    } else {
      process.exit(1);
    }
    return;
  }

  // Pass all arguments to server
  const serverArgs = process.argv.slice(2);
  const nodeExecPath = process.execPath;
  const resolvedServerPath = path.resolve(serverPath);

  // Verify server file exists
  if (!fs.existsSync(resolvedServerPath)) {
    process.stderr.write(`[MCP Proxy] ✗ Server file not found: ${resolvedServerPath}\n`);
    if (process.platform === 'win32') {
      setTimeout(() => process.exit(1), 30000);
    } else {
      process.exit(1);
    }
    return;
  }

  const serverEnv = {
    ...process.env,
  };

  // Debug logging for Windows
  if (process.platform === 'win32') {
    process.stderr.write(`[MCP Proxy] Spawning server: ${nodeExecPath} ${resolvedServerPath}\n`);
    process.stderr.write(`[MCP Proxy] CWD: ${process.cwd()}\n`);
  }

  // Spawn the server process
  const serverProcess = spawn(nodeExecPath, [resolvedServerPath, ...serverArgs], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: serverEnv,
    cwd: process.cwd(),
    shell: false,
  });

  // Handle server process exit
  serverProcess.on('close', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[MCP Proxy] Server exited with code: ${code}\n`);
    }
    process.exit(code || 0);
  });

  // Handle server process errors
  serverProcess.on('error', (error) => {
    process.stderr.write(`[MCP Proxy] ✗ Failed to start server: ${error.message}\n`);
    if (error.stack) {
      process.stderr.write(error.stack + '\n');
    }
    if (process.platform === 'win32') {
      setTimeout(() => process.exit(1), 30000);
    } else {
      process.exit(1);
    }
  });

  // Forward SIGINT (Ctrl+C) to server process
  process.on('SIGINT', () => {
    serverProcess.kill('SIGINT');
    setTimeout(() => {
      process.exit(0);
    }, 500);
  });
}

// Run launcher
main();


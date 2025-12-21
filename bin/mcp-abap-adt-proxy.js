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
  --btp=<destination>     Override x-btp-destination header (for BTP Cloud authorization)
                           Optional: either --btp, --mcp, or --mcp-url is required for stdio/SSE transports
  --mcp=<destination>      Override x-mcp-destination header (for SAP ABAP connection)
                           Optional: either --btp, --mcp, or --mcp-url is required for stdio/SSE transports
                           Can be used without --btp for local testing (no BTP authentication)
  --mcp-url=<url>         Direct MCP server URL (for local testing without BTP)
                           Optional: either --btp, --mcp, or --mcp-url is required for stdio/SSE transports
                           Used for local testing without authentication
  --browser-auth-port=<port>  OAuth callback port for browser authentication (default: 3001)
                              Use different port (e.g., 3101) to avoid conflicts when proxy runs on port 3001
  --config=<file>, -c     Load configuration from YAML or JSON file
                           Alternative to command-line parameters
  --unsafe                 Enable file-based session storage (persists tokens to disk)
  --help, -h              Show this help message
  --version, -v           Show version number

Environment Variables:
  CLOUD_LLM_HUB_URL       Cloud LLM Hub URL
  MCP_HTTP_PORT           HTTP server port (default: 3001)
  MCP_SSE_PORT            SSE server port (default: 3002)
  MCP_HTTP_HOST           HTTP server host (default: 0.0.0.0)
  MCP_SSE_HOST            SSE server host (default: 0.0.0.0)
  MCP_TRANSPORT           Transport type (stdio|http|sse)
  MCP_PROXY_UNSAFE        Enable file-based session storage (set to "true")
  MCP_BROWSER_AUTH_PORT   OAuth callback port for browser authentication (default: 3001)

Examples:
  mcp-abap-adt-proxy                                    # Use default transport
  mcp-abap-adt-proxy --transport=stdio --btp=ai         # Use stdio transport with --btp
  mcp-abap-adt-proxy --transport=stdio --mcp=trial      # Use stdio with --mcp only (local testing, no BTP auth)
  mcp-abap-adt-proxy --transport=stdio --mcp-url=http://localhost:3000/mcp  # Use stdio with direct MCP URL (local testing)
  mcp-abap-adt-proxy --transport=stdio --btp=ai --mcp=trial  # Use stdio with both destinations
  mcp-abap-adt-proxy --transport=http                   # HTTP mode (port 3001)
  mcp-abap-adt-proxy --transport=http --http-port=8080  # HTTP mode on custom port
  mcp-abap-adt-proxy --transport=sse --btp=ai --mcp=trial  # SSE mode with destinations
  mcp-abap-adt-proxy --transport=sse --mcp=trial        # SSE mode with --mcp only (local testing)
  mcp-abap-adt-proxy --transport=sse --mcp-url=http://localhost:3000/mcp  # SSE mode with direct MCP URL
  mcp-abap-adt-proxy --transport=sse --sse-port=3002     # SSE mode on port 3002
  mcp-abap-adt-proxy --btp=ai --mcp=trial               # With destination overrides
  mcp-abap-adt-proxy --mcp=trial                        # Local testing mode (no BTP authentication)
  mcp-abap-adt-proxy --mcp-url=http://localhost:3000/mcp  # Local testing with direct MCP URL (no authentication)
  mcp-abap-adt-proxy --btp=ai --mcp=trial --unsafe      # With file-based session storage
  mcp-abap-adt-proxy --browser-auth-port=3101           # Use custom OAuth callback port (avoids conflict with proxy on 3001)
  mcp-abap-adt-proxy --config=proxy-config.yaml         # Load configuration from YAML file
  mcp-abap-adt-proxy -c proxy-config.yml                # Load configuration from YAML file (short form)

Transport Modes:
  - stdio (default if stdin is not TTY): For MCP clients like Cline/Cursor
  - http / streamable-http: HTTP server (default if stdin is TTY, port 3001)
  - sse: Server-Sent Events server (port 3002)

Usage Modes:

1. BTP Authentication Mode (with --btp):
   - Adds Authorization: Bearer <token> header from BTP destination
   - Gets MCP server URL from BTP destination service key
   - Works with any BTP service, not just SAP ABAP
   Example: mcp-abap-adt-proxy --btp=ai

2. BTP + SAP Configuration Mode (--btp + --mcp):
   - Adds Authorization: Bearer <token> header from BTP destination
   - Adds SAP headers (x-sap-jwt-token, x-sap-url, etc.) from MCP destination
   - Gets MCP server URL from BTP destination service key
   - Suitable for SAP ABAP systems that require both BTP and SAP authentication
   Example: mcp-abap-adt-proxy --btp=ai --mcp=trial

3. Local Testing Mode (only --mcp or --mcp-url):
   - No BTP authentication required
   - Gets MCP server URL from MCP destination service key (--mcp) or uses direct URL (--mcp-url)
   - Optional SAP token (won't fail if unavailable)
   - Enables local integration testing without BTP authentication
   Example: mcp-abap-adt-proxy --mcp=trial
   Example: mcp-abap-adt-proxy --mcp-url=http://localhost:3000/mcp

Headers (for HTTP/SSE transports):
  - x-btp-destination: Destination for BTP Cloud authorization (optional if --btp is used)
  - x-mcp-destination: Destination for SAP ABAP connection (optional if --mcp is used)
  - x-mcp-url: Direct MCP server URL (optional if --mcp-url is used)
  
  At least one of the above headers (or corresponding --btp/--mcp/--mcp-url parameter) is required.

Service Keys:
  Service keys should be placed in:
  - Unix: ~/.config/mcp-abap-adt/service-keys/<destination>.json
  - Windows: %USERPROFILE%\\Documents\\mcp-abap-adt\\service-keys\\<destination>.json
  
  For BTP destination, service key should contain:
  {
    "uaa": { "url": "...", "clientid": "...", "clientsecret": "..." },
    "abap": { "url": "https://your-mcp-server.com" }
  }
  
  The "abap.url" field is used as the MCP server URL (even for non-SAP services).

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


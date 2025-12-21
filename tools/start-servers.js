#!/usr/bin/env node

/**
 * Start both mcp-abap-adt and mcp-abap-adt-proxy servers for testing
 * 
 * Usage:
 *   node tools/start-servers.js
 *   node tools/start-servers.js --adt-port=3000 --proxy-port=3001
 *   node tools/start-servers.js --adt-port=3000 --proxy-port=3001 --mcp-url=http://localhost:3000/mcp
 */

const { spawn } = require('child_process');
const path = require('path');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    // Default: both servers use HTTP transport
    adtPort: 3000,  // Default: HTTP port for ADT server
    proxyPort: 3001,  // Default: HTTP port for Proxy server
    adtHost: '0.0.0.0',
    proxyHost: '0.0.0.0',
    transport: 'http',  // Default: HTTP for both servers (sse|http)
    mcpUrl: undefined,
    mcpDestination: undefined,
    btpDestination: undefined,
    adtEnv: undefined,
    proxyUnsafe: false,
    browserAuthPort: 3101,  // Default: OAuth callback port (to avoid conflict with proxy on 3001)
  };

  for (const arg of args) {
    if (arg.startsWith('--adt-port=')) {
      config.adtPort = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--proxy-port=')) {
      config.proxyPort = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--adt-host=')) {
      config.adtHost = arg.split('=')[1];
    } else if (arg.startsWith('--proxy-host=')) {
      config.proxyHost = arg.split('=')[1];
    } else if (arg.startsWith('--mcp-url=')) {
      config.mcpUrl = arg.split('=')[1];
    } else if (arg.startsWith('--mcp=')) {
      config.mcpDestination = arg.split('=')[1];
    } else if (arg.startsWith('--btp=')) {
      config.btpDestination = arg.split('=')[1];
    } else if (arg.startsWith('--adt-env=')) {
      config.adtEnv = arg.split('=')[1];
    } else if (arg.startsWith('--transport=')) {
      config.transport = arg.split('=')[1];
    } else if (arg.startsWith('--browser-auth-port=')) {
      config.browserAuthPort = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--proxy-unsafe') {
      config.proxyUnsafe = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }
  }

  // Always auto-generate mcpUrl based on ADT server configuration
  // User can override with --mcp-url if needed, but by default we use the ADT server we just started
  // Both servers use the same transport, so mcpUrl matches the transport
  const host = config.adtHost === '0.0.0.0' ? 'localhost' : config.adtHost;
  if (!config.mcpUrl) {
    if (config.transport === 'sse') {
      // For SSE, the endpoint is /sse or /mcp/events
      config.mcpUrl = `http://${host}:${config.adtPort}/sse`;
    } else {
      // For HTTP, the endpoint is /mcp/stream/http
      config.mcpUrl = `http://${host}:${config.adtPort}/mcp/stream/http`;
    }
  }

  return config;
}

function showHelp() {
  console.log(`
Start both mcp-abap-adt and mcp-abap-adt-proxy servers for testing

Usage:
  node tools/start-servers.js [options]

Options:
  --adt-port=<port>        ADT server port (default: 3000)
  --proxy-port=<port>      Proxy server port (default: 3001)
  --adt-host=<host>        ADT server host (default: 0.0.0.0)
  --proxy-host=<host>      Proxy server host (default: 0.0.0.0)
  --transport=<type>       Transport for both servers: sse|http (default: http)
                            Both ADT and Proxy use the same transport protocol
  --mcp-url=<url>         MCP server URL for proxy (auto-generated from ADT server config)
  --mcp=<destination>     MCP destination name for proxy
  --btp=<destination>     BTP destination name for proxy
  --adt-env=<path>         Path to .env file for ADT server
  --proxy-unsafe           Enable unsafe (file-based) session storage for proxy
  --browser-auth-port=<port>  OAuth callback port for browser authentication (default: 3101)
  --help, -h               Show this help message

Examples:
  # Start both servers with default ports (both HTTP: ADT 3000, Proxy 3001)
  node tools/start-servers.js

  # Start with MCP destination (local testing, mcp-url auto-generated)
  node tools/start-servers.js --mcp=trial

  # Start with custom ports
  node tools/start-servers.js --adt-port=3000 --proxy-port=3001

  # Start with SSE transport (both servers use SSE)
  node tools/start-servers.js --transport=sse

  # Start with SSE and custom ports
  node tools/start-servers.js --transport=sse --adt-port=3001 --proxy-port=3002

  # Override auto-generated MCP URL (usually not needed)
  node tools/start-servers.js --mcp=trial --mcp-url=http://localhost:3000/custom/path

  # Start with BTP destination
  node tools/start-servers.js --btp=ai --mcp=trial

  # Start with custom .env file for ADT
  node tools/start-servers.js --adt-env=./.env.test
`);
}

// Find executable paths
function findExecutable(name) {
  const fs = require('fs');
  
  // Try local node_modules/.bin first (for local development)
  const localPath = path.join(process.cwd(), 'node_modules', '.bin', name);
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  
  // Try parent directory (if running from tools/)
  const parentPath = path.join(process.cwd(), '..', 'node_modules', '.bin', name);
  if (fs.existsSync(parentPath)) {
    return parentPath;
  }
  
  // Try which/where command (Unix/Windows) - checks PATH
  const { execSync } = require('child_process');
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${which} ${name}`, { 
      encoding: 'utf-8', 
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    });
    const foundPath = result.trim().split('\n')[0];
    if (foundPath && fs.existsSync(foundPath)) {
      return foundPath;
    }
  } catch (error) {
    // Executable not found in PATH, continue
  }
  
  // Fallback: assume it's in PATH (will be resolved by spawn)
  return name;
}

// Start ADT server
function startAdtServer(config) {
  const adtExecutable = findExecutable('mcp-abap-adt');
  
  const args = [
    `--transport=${config.transport}`,
  ];
  
  if (config.transport === 'sse') {
    args.push(`--sse-port=${config.adtPort}`);
    args.push(`--sse-host=${config.adtHost}`);
  } else {
    args.push(`--http-port=${config.adtPort}`);
    args.push(`--http-host=${config.adtHost}`);
  }
  
  if (config.adtEnv) {
    args.push(`--env=${config.adtEnv}`);
  }
  
  console.log(`[ADT] Starting mcp-abap-adt on ${config.adtHost}:${config.adtPort} (${config.transport})...`);
  console.log(`[ADT] Command: ${adtExecutable} ${args.join(' ')}`);
  
  const adtProcess = spawn(adtExecutable, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
  });
  
  adtProcess.stdout.on('data', (data) => {
    process.stdout.write(`[ADT] ${data}`);
  });
  
  adtProcess.stderr.on('data', (data) => {
    process.stderr.write(`[ADT] ${data}`);
  });
  
  adtProcess.on('error', (error) => {
    console.error(`[ADT] Failed to start: ${error.message}`);
    console.error(`[ADT] Make sure mcp-abap-adt is installed: npm install -g @mcp-abap-adt/server`);
  });
  
  adtProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[ADT] Process exited with code ${code}`);
    }
  });
  
  return adtProcess;
}

// Start Proxy server
function startProxyServer(config) {
  const proxyExecutable = findExecutable('mcp-abap-adt-proxy');
  
  const args = [
    `--transport=${config.transport}`,
  ];
  
  if (config.transport === 'sse') {
    args.push(`--sse-port=${config.proxyPort}`);
    args.push(`--sse-host=${config.proxyHost}`);
  } else {
    args.push(`--http-port=${config.proxyPort}`);
    args.push(`--http-host=${config.proxyHost}`);
  }
  
  // Always pass mcpUrl to proxy (auto-generated from ADT server config)
  // This ensures proxy knows where to connect to the ADT server we just started
  args.push(`--mcp-url=${config.mcpUrl}`);
  
  if (config.mcpDestination) {
    args.push(`--mcp=${config.mcpDestination}`);
  }
  
  if (config.btpDestination) {
    args.push(`--btp=${config.btpDestination}`);
  }
  
  if (config.proxyUnsafe) {
    args.push('--unsafe');
  }
  
  // Add browser auth port to avoid conflict with proxy port
  args.push(`--browser-auth-port=${config.browserAuthPort}`);
  
  console.log(`[PROXY] Starting mcp-abap-adt-proxy on ${config.proxyHost}:${config.proxyPort} (${config.transport})...`);
  console.log(`[PROXY] Command: ${proxyExecutable} ${args.join(' ')}`);
  
  const proxyProcess = spawn(proxyExecutable, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
  });
  
  proxyProcess.stdout.on('data', (data) => {
    process.stdout.write(`[PROXY] ${data}`);
  });
  
  proxyProcess.stderr.on('data', (data) => {
    process.stderr.write(`[PROXY] ${data}`);
  });
  
  proxyProcess.on('error', (error) => {
    console.error(`[PROXY] Failed to start: ${error.message}`);
    console.error(`[PROXY] Make sure mcp-abap-adt-proxy is installed: npm install -g @mcp-abap-adt/proxy`);
  });
  
  proxyProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[PROXY] Process exited with code ${code}`);
    }
  });
  
  return proxyProcess;
}

// Main function
function main() {
  const config = parseArgs();
  
  console.log('='.repeat(60));
  console.log('Starting MCP ABAP ADT Test Servers');
  console.log('='.repeat(60));
  console.log(`Transport:     ${config.transport} (both servers use the same transport)`);
  console.log(`ADT Server:    http://${config.adtHost}:${config.adtPort} (${config.transport})`);
  console.log(`Proxy Server:  http://${config.proxyHost}:${config.proxyPort} (${config.transport})`);
  console.log(`MCP URL:       ${config.mcpUrl} (auto-generated from ADT server config)`);
  console.log(`Browser Auth Port: ${config.browserAuthPort} (OAuth callback port)`);
  if (config.mcpDestination) {
    console.log(`MCP Destination: ${config.mcpDestination}`);
  }
  if (config.btpDestination) {
    console.log(`BTP Destination: ${config.btpDestination}`);
  }
  console.log('='.repeat(60));
  console.log('Press Ctrl+C to stop both servers\n');
  
  // Start both servers
  const adtProcess = startAdtServer(config);
  const proxyProcess = startProxyServer(config);
  
  // Wait a bit for servers to start
  setTimeout(() => {
    console.log('\n' + '='.repeat(60));
    console.log('Servers started!');
    console.log('='.repeat(60));
    console.log(`Transport:     ${config.transport} (both servers use the same transport)`);
    console.log(`ADT Server:    http://${config.adtHost}:${config.adtPort} (${config.transport})`);
    console.log(`Proxy Server:  http://${config.proxyHost}:${config.proxyPort} (${config.transport})`);
    console.log(`MCP URL:       ${config.mcpUrl} (auto-generated from ADT server config)`);
    console.log(`Browser Auth Port: ${config.browserAuthPort} (OAuth callback port)`);
    console.log('='.repeat(60) + '\n');
  }, 2000);
  
  // Handle shutdown
  const shutdown = (signal) => {
    console.log(`\n[SHUTDOWN] Received ${signal}, shutting down servers...`);
    
    if (adtProcess && !adtProcess.killed) {
      adtProcess.kill('SIGTERM');
    }
    
    if (proxyProcess && !proxyProcess.killed) {
      proxyProcess.kill('SIGTERM');
    }
    
    // Force kill after 5 seconds
    setTimeout(() => {
      if (adtProcess && !adtProcess.killed) {
        adtProcess.kill('SIGKILL');
      }
      if (proxyProcess && !proxyProcess.killed) {
        proxyProcess.kill('SIGKILL');
      }
      process.exit(0);
    }, 5000);
  };
  
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  
  // Handle process exit
  process.on('exit', () => {
    if (adtProcess && !adtProcess.killed) {
      adtProcess.kill('SIGTERM');
    }
    if (proxyProcess && !proxyProcess.killed) {
      proxyProcess.kill('SIGTERM');
    }
  });
}

// Run main function
if (require.main === module) {
  main();
}

module.exports = { startAdtServer, startProxyServer, parseArgs };


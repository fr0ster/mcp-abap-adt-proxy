#!/usr/bin/env node

/**
 * Test script to verify BTP authorization via the proxy.
 * 
 * Usage:
 *   node tools/test-btp-auth.js --destination=<dest> [options]
 * 
 * Options:
 *   --destination=<dest>, -d   BTP destination name (required)
 *   --target-url=<url>         Explicit target URL (overrides destination URL)
 *   --method=<method>          HTTP Method (GET, POST, etc.) - Default: POST
 *   --proxy-url=<url>          Proxy URL (default: http://localhost:3001)
 *   --help, -h                 Show this help message
 * 
 * Example:
 *   node tools/test-btp-auth.js --destination=ai
 *   node tools/test-btp-auth.js --destination=ai --target-url=https://my-sap-system.com/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ --method=GET
 */

const axios = require('axios');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    destination: '',
    targetUrl: '',
    method: 'POST',
    proxyUrl: 'http://localhost:3001',
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--destination=')) {
      result.destination = arg.split('=')[1];
    } else if (arg === '-d' && i + 1 < args.length) {
      result.destination = args[++i];
    } else if (arg.startsWith('--target-url=')) {
      result.targetUrl = arg.split('=')[1];
    } else if (arg.startsWith('--method=')) {
      result.method = arg.split('=')[1].toUpperCase();
    } else if (arg.startsWith('--proxy-url=')) {
      result.proxyUrl = arg.split('=')[1];
    } else if (arg.startsWith('--path=')) {
      result.path = arg.split('=')[1];
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    }
  }

  // Ensure path starts with / if present and not empty
  if (result.path && !result.path.startsWith('/')) {
      result.path = '/' + result.path;
  }
  
  return result;
}

async function main() {
  const args = parseArgs();

  if (args.help || !args.destination) {
    console.log(`
Usage: node tools/test-btp-auth.js --destination=<dest> [options]

Options:
  --destination=<dest>, -d   BTP destination name (required)
  --target-url=<url>         Explicit target URL (overrides destination URL)
  --method=<method>          HTTP Method (GET, POST, etc.) - Default: POST
  --proxy-url=<url>          Proxy URL (default: http://localhost:3001)
  --path=<path>              Request path (e.g. /odata/v4) - Default: /
  --help, -h                 Show this help message
`);
    process.exit(args.help ? 0 : 1);
  }

  console.log(`Testing BTP authorization for destination: ${args.destination}`);
  if (args.targetUrl) {
    console.log(`Target URL Override: ${args.targetUrl}`);
  }
  console.log(`HTTP Method: ${args.method}`);
  console.log(`Proxy URL: ${args.proxyUrl}`);
  console.log(`Path: ${args.path || '/'}`);

  // Construct payload based on method
  let payload = undefined;
  if (args.method === 'POST') {
     // Default MCP init payload for POST
     payload = {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'test-btp-auth-script',
            version: '1.0.0'
          }
        },
        id: 1
      };
  }

  try {
    console.log(`Sending ${args.method} request to ${args.proxyUrl}${args.path || ''}...`);
    
    const headers = {
       'x-btp-destination': args.destination
    };
    
    if (args.targetUrl) {
        headers['x-target-url'] = args.targetUrl;
    }
    
    if (payload) {
        headers['Content-Type'] = 'application/json';
    }

    // Handle URL construction safely
    let fullUrl = args.proxyUrl;
    if (args.path) {
        // Remove trailing slash from proxyUrl if present
        if (fullUrl.endsWith('/')) {
            fullUrl = fullUrl.slice(0, -1);
        }
        // Path already ensures leading slash
        fullUrl += args.path;
    }

    const response = await axios({
      method: args.method,
      url: fullUrl,
      data: payload,
      headers: headers,
      // specific standard OData/REST error handling if needed, 
      // but we mainly want to see implied 401/403 vs 200/500
      validateStatus: (status) => true 
    });

    console.log('---------------------------------------------------');
    console.log(`Status Code: ${response.status} ${response.statusText}`);
    console.log('Headers:', JSON.stringify(response.headers, null, 2));
    if (response.data) {
        // limit large output
        const dataStr = JSON.stringify(response.data, null, 2);
        console.log('Response Body:', dataStr.length > 2000 ? dataStr.substring(0, 2000) + '...' : dataStr);
    } else {
        console.log('Response Body: <empty>');
    }
    console.log('---------------------------------------------------');

    if (response.status >= 200 && response.status < 300) {
      console.log('✅ Request proxied successfully (Status 2xx).');
      if (payload && response.data && response.data.error) {
         console.warn('⚠️  Target service returned a JSON-RPC error (this is okay, it means Auth worked):', response.data.error.message);
      } else {
         console.log('🎉 Target service returned a success result.');
      }
    } else if (response.status === 401 || response.status === 403) {
      console.error('❌ Authorization Failed. The proxy or BTP rejected the credentials.');
      process.exit(1);
    } else {
      console.warn(`⚠️  Received unexpected status code ${response.status}. Check logs.`);
    }

  } catch (error) {
    console.error('❌ Request failed:', error.message);
    if (error.response) {
      console.error('Response Status:', error.response.status);
      console.error('Response Data:', error.response.data);
    } else if (error.request) {
        console.error('No response received (Connection refused?)');
    }
    process.exit(1);
  }
}

main();

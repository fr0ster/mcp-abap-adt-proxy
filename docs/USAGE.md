# Usage Examples

This document provides practical examples of using `@mcp-abap-adt/proxy`.

## Installation

```bash
npm install @mcp-abap-adt/proxy
```

## Basic Usage

### Starting the Proxy Server

#### Using Default Configuration

```bash
# Set required environment variable
export CLOUD_LLM_HUB_URL="https://cloud-llm-hub.example.com"

# Start server
mcp-abap-adt-proxy
```

#### Using Configuration File

Create `mcp-proxy-config.json`:

```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com",
  "httpPort": 3001,
  "logLevel": "info"
}
```

Start server:
```bash
mcp-abap-adt-proxy
```

#### Using Environment Variables

```bash
export CLOUD_LLM_HUB_URL="https://cloud-llm-hub.example.com"
export MCP_HTTP_PORT=8080
export LOG_LEVEL=debug
mcp-abap-adt-proxy
```

## Usage Scenarios

### Scenario 1: BTP Authentication Mode

**Use Case:** Proxy requests to an MCP server on BTP with JWT authentication

**Client Configuration:**
```json
{
  "mcp-abap-adt-proxy": {
    "disabled": false,
    "timeout": 60,
    "type": "streamableHttp",
    "url": "http://localhost:3001/mcp/stream/http",
    "headers": {
      "x-btp-destination": "btp-cloud"
    }
  }
}
```

**What Happens:**
1. Proxy receives request with `x-btp-destination` header
2. Command line override (`--btp`) takes precedence over header if provided
3. Uses `btpAuthBroker` with `ClientCredentialsProvider` to get BTP Cloud token from service key
4. Gets MCP server URL from service key (`abap.url` field)
5. Injects/overwrites `Authorization: Bearer <btp-token>` header
6. Proxies request to MCP server URL from service key
7. Target MCP server processes request and returns response
8. Proxy forwards response to client

**Using Command Line Overrides:**

You can override headers using command line parameters:

```bash
# Override x-btp-destination with --btp
mcp-abap-adt-proxy --btp=ai
```

Command line parameters work even if the corresponding headers are missing in the request.

### Scenario 2: Local Testing Mode (No Authentication)

**Use Case:** Proxy requests to a local MCP server without authentication. Useful for development and testing.

**Client Configuration:**
```json
{
  "mcp-abap-adt-proxy": {
    "disabled": false,
    "timeout": 60,
    "type": "streamableHttp",
    "url": "http://localhost:3001/mcp/stream/http",
    "headers": {
      "x-mcp-url": "http://localhost:3000/mcp/stream/http"
    }
  }
}
```

**Or using command line:**
```bash
mcp-abap-adt-proxy --mcp-url=http://localhost:3000/mcp/stream/http
```

**What Happens:**
1. Proxy receives request with `x-mcp-url` header (or `--mcp-url` parameter)
2. No authentication is performed
3. All headers from the request are passed through to the MCP server
4. Proxies request to the specified URL
5. Target MCP server processes request and returns response
6. Proxy forwards response to client

**Service Key Structure:**
The service key for BTP destination should contain the MCP server URL:
```json
{
  "uaa": {
    "url": "https://your-uaa-url.com",
    "clientid": "your-client-id",
    "clientsecret": "your-client-secret"
  },
  "abap": {
    "url": "https://your-mcp-server.com"
  }
}
```

The `abap.url` field is used as the MCP server URL (even though it's named "abap", it can point to any MCP server).

## Programmatic Usage

### Using as a Library

```typescript
import { McpAbapAdtProxyServer } from "@mcp-abap-adt/proxy";

async function main() {
  const server = new McpAbapAdtProxyServer();

  // Handle shutdown gracefully
  process.on("SIGINT", async () => {
    await server.shutdown();
    process.exit(0);
  });

  await server.run();
}

main().catch(console.error);
```

### Custom Configuration

```typescript
import { McpAbapAdtProxyServer } from "@mcp-abap-adt/proxy";
import { parseTransportConfig } from "@mcp-abap-adt/proxy/lib/transportConfig";

const transportConfig = parseTransportConfig();
const server = new McpAbapAdtProxyServer(
  transportConfig,
  "/path/to/custom-config.json"
);

await server.run();
```

## Transport Modes

### HTTP/Streamable HTTP (Default)

```bash
mcp-abap-adt-proxy --transport=streamable-http --http-port=3001
```

### SSE (Server-Sent Events)

```bash
mcp-abap-adt-proxy --transport=sse --sse-port=3002
```

### Stdio (for MCP clients)

```bash
mcp-abap-adt-proxy --transport=stdio
```

## Advanced Configuration

### Custom Retry Settings

```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com",
  "maxRetries": 5,
  "retryDelay": 2000,
  "requestTimeout": 120000
}
```

### Circuit Breaker Configuration

```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com",
  "circuitBreakerThreshold": 10,
  "circuitBreakerTimeout": 120000
}
```

## Integration Examples

### With Cline

1. Install proxy:
```bash
npm install -g @mcp-abap-adt/proxy
```

2. Start proxy server:
```bash
mcp-abap-adt-proxy --btp=btp-cloud
```

3. Configure Cline (`cline.json`):
```json
{
  "mcpServers": {
    "mcp-abap-adt-proxy": {
      "disabled": false,
      "timeout": 60,
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp/stream/http",
      "headers": {
        "x-btp-destination": "btp-cloud"
      }
    }
  }
}
```

### With Custom MCP Client

```typescript
import axios from "axios";

async function callProxy(method: string, params: any) {
  const response = await axios.post(
    "http://localhost:3001/mcp/stream/http",
    {
      jsonrpc: "2.0",
      method,
      params,
      id: 1,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-btp-destination": "btp-cloud",
      },
    }
  );

  return response.data;
}

// Example usage
const result = await callProxy("tools/list", {});
console.log(result);
```

## Service Key Setup

For BTP destination-based authentication, you need to set up service keys:

1. Create service key file: `btp-cloud.json`
```json
{
  "uaa": {
    "url": "https://your-uaa-url.com",
    "clientid": "your-client-id",
    "clientsecret": "your-client-secret"
  },
  "abap": {
    "url": "https://your-mcp-server.com"
  }
}
```

2. Place service key in platform-specific location:
   - **Unix**: `~/.config/mcp-abap-adt/service-keys/btp-cloud.json`
   - **Windows**: `%USERPROFILE%\Documents\mcp-abap-adt\service-keys\btp-cloud.json`

3. Use destination in proxy:
```bash
mcp-abap-adt-proxy --btp=btp-cloud
```
Or via header:
```json
{
  "headers": {
    "x-btp-destination": "btp-cloud"
  }
}
```

## Debugging

### Enable Debug Logging

```bash
export LOG_LEVEL=debug
export DEBUG_HTTP_REQUESTS=true
mcp-abap-adt-proxy
```

### Check Routing Decisions

The proxy logs routing decisions:
```
[INFO] Routing decision made: { strategy: "PROXY", btpDestination: "btp-cloud" }
```

### Monitor Circuit Breaker

Circuit breaker state is logged:
```
[WARN] Circuit breaker opened due to failures: { failures: 5, threshold: 5 }
```

## Common Patterns

### Pattern 1: Development Environment

```bash
export LOG_LEVEL=debug
export MCP_HTTP_PORT=3001

mcp-abap-adt-proxy --mcp-url=http://localhost:3000
```

### Pattern 2: Production Environment

```json
// mcp-proxy-config.json
{
  "cloudLlmHubUrl": "https://prod-cloud-llm-hub.example.com",
  "httpPort": 3001,
  "logLevel": "info",
  "maxRetries": 5,
  "circuitBreakerThreshold": 10
}
```

### Pattern 3: Multiple Destinations

Use different destination names for different environments:

```json
{
  "headers": {
    "x-btp-destination": "dev-btp"
  }
}
```

```json
{
  "headers": {
    "x-btp-destination": "prod-btp"
  }
}
```

### Pattern 4: Using Command Line Overrides

Override destination via command line (useful for development/testing):

```bash
# Use 'ai' for BTP regardless of headers
mcp-abap-adt-proxy --btp=ai
```

This is especially useful when you want to use the same destination for all requests without modifying client configuration.

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

### Scenario 1: Proxy to Cloud LLM Hub

**Use Case:** Proxy requests to cloud-llm-hub with JWT authentication

**Client Configuration:**
```json
{
  "mcp-abap-adt-proxy": {
    "disabled": false,
    "timeout": 60,
    "type": "streamableHttp",
    "url": "http://localhost:3001/mcp/stream/http",
      "headers": {
        "x-mcp-url": "https://cloud-llm-hub.example.com/mcp/stream/http",
        "x-btp-destination": "btp-cloud",
        "x-mcp-destination": "sap-abap"
      }
  }
}
```

**What Happens:**
1. Proxy receives request with `x-mcp-url`, `x-btp-destination`, and `x-mcp-destination` headers
2. Command line overrides (`--btp` and `--mcp`) take precedence over headers if provided
3. Gets BTP Cloud token from auth-broker for `x-btp-destination` (or `--btp`) destination
4. Gets SAP ABAP token and configuration from auth-broker for `x-mcp-destination` (or `--mcp`) destination
5. Adds `Authorization: Bearer <btp-token>` header
6. Adds SAP headers (`x-sap-jwt-token`, `x-sap-url`, etc.)
7. Proxies request to URL specified in `x-mcp-url`
8. Target MCP server processes request and returns response
9. Proxy forwards response to client

**Using Command Line Overrides:**

You can override headers using command line parameters:

```bash
# Override x-btp-destination with --btp
mcp-abap-adt-proxy --btp=ai

# Override x-mcp-destination with --mcp
mcp-abap-adt-proxy --mcp=trial

# Override both
mcp-abap-adt-proxy --btp=ai --mcp=trial
```

Command line parameters work even if the corresponding headers are missing in the request.

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
export CLOUD_LLM_HUB_URL="https://cloud-llm-hub.example.com"
mcp-abap-adt-proxy
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
        "x-mcp-url": "https://cloud-llm-hub.example.com/mcp/stream/http",
        "x-sap-destination": "sk"
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
        "x-mcp-url": "https://cloud-llm-hub.example.com/mcp/stream/http",
        "x-btp-destination": "btp-cloud",
        "x-mcp-destination": "sap-abap",
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

For destination-based authentication, you need to set up service keys:

1. Create service key file: `sk.json`
```json
{
  "uaa": {
    "url": "https://your-uaa-url.com",
    "clientid": "your-client-id",
    "clientsecret": "your-client-secret"
  },
  "abap": {
    "url": "https://your-abap-system.com",
    "client": "100"
  }
}
```

2. Place service key in platform-specific location:
   - **Unix**: `~/.config/mcp-abap-adt/service-keys/sk.json`
   - **Windows**: `%USERPROFILE%\Documents\mcp-abap-adt\service-keys\sk.json`

3. Use destination in requests:
```json
{
  "headers": {
    "x-sap-destination": "sk"
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
[INFO] Routing decision made: { strategy: "proxy-cloud-llm-hub", destination: "sk" }
```

### Monitor Circuit Breaker

Circuit breaker state is logged:
```
[WARN] Circuit breaker opened due to failures: { failures: 5, threshold: 5 }
```

## Common Patterns

### Pattern 1: Development Environment

```bash
# .env or environment variables
export CLOUD_LLM_HUB_URL="https://dev-cloud-llm-hub.example.com"
export LOG_LEVEL=debug
export MCP_HTTP_PORT=3001

mcp-abap-adt-proxy
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

### Pattern 3: Multiple Destinations and MCP Servers

Use different destination names and MCP server URLs:

```json
{
  "headers": {
    "x-mcp-url": "https://dev-cloud-llm-hub.example.com/mcp/stream/http",
    "x-btp-destination": "dev-btp",
    "x-mcp-destination": "dev-sap"
  }
}
```

```json
{
  "headers": {
    "x-mcp-url": "https://prod-cloud-llm-hub.example.com/mcp/stream/http",
    "x-btp-destination": "prod-btp",
    "x-mcp-destination": "prod-sap"
  }
}
```

### Pattern 4: Using Command Line Overrides

Override destinations via command line (useful for development/testing):

```bash
# Use 'ai' for BTP and 'trial' for SAP regardless of headers
mcp-abap-adt-proxy --btp=ai --mcp=trial
```

This is especially useful when you want to use the same destinations for all requests without modifying client configuration.


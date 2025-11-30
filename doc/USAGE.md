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

## Routing Scenarios

### Scenario 1: Direct Cloud Routing

**Use Case:** Connect directly to cloud ABAP system (e.g., S4HANA_E19)

**Client Configuration (Cline):**
```json
{
  "mcp-abap-adt-proxy": {
    "disabled": false,
    "timeout": 60,
    "type": "streamableHttp",
    "url": "http://localhost:3001/mcp/stream/http",
    "headers": {
      "x-sap-destination": "S4HANA_E19"
    }
  }
}
```

**What Happens:**
1. Proxy receives request with `x-sap-destination: "S4HANA_E19"`
2. Analyzes headers and determines `DIRECT_CLOUD` strategy
3. Creates ABAP connection using destination service key
4. Routes request directly to cloud ABAP system
5. Returns response to client

### Scenario 2: Local Basic Auth

**Use Case:** Connect to on-premise ABAP system with basic authentication

**Client Configuration:**
```json
{
  "mcp-abap-adt-proxy": {
    "disabled": false,
    "timeout": 60,
    "type": "streamableHttp",
    "url": "http://localhost:3001/mcp/stream/http",
    "headers": {
      "x-sap-url": "https://onpremise.sap.com",
      "x-sap-auth-type": "basic",
      "x-sap-login": "username",
      "x-sap-password": "password",
      "x-sap-client": "100"
    }
  }
}
```

**What Happens:**
1. Proxy receives request with `x-sap-auth-type: "basic"`
2. Analyzes headers and determines `LOCAL_BASIC` strategy
3. Creates ABAP connection with basic auth
4. Handles request locally (no proxying)
5. Returns response to client

### Scenario 3: Proxy to Cloud LLM Hub

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
      "x-sap-destination": "sk"
    }
  }
}
```

**What Happens:**
1. Proxy receives request with `x-sap-destination: "sk"`
2. Analyzes headers and determines `PROXY_CLOUD_LLM_HUB` strategy
3. Gets JWT token from auth-broker for destination "sk"
4. Proxies request to cloud-llm-hub with JWT token
5. Cloud-llm-hub processes request and returns response
6. Proxy forwards response to client

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
        "x-sap-destination": "sk",
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

### Pattern 3: Multiple Destinations

Use different destination names for different systems:

```json
{
  "headers": {
    "x-sap-destination": "dev"  // Uses dev.json service key
  }
}
```

```json
{
  "headers": {
    "x-sap-destination": "prod"  // Uses prod.json service key
  }
}
```


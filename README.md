# @mcp-abap-adt/proxy

MCP proxy server for SAP ABAP ADT - proxies local requests to cloud-llm-hub with JWT authentication.

## Overview

This package acts as a proxy between local MCP clients (like Cline) and the cloud-based MCP server (`cloud-llm-hub`). It intercepts MCP requests, analyzes authentication headers, and routes them appropriately:

- **Direct cloud requests** (`x-sap-destination: "S4HANA_E19"`) - forwarded directly to cloud ABAP
- **Basic auth requests** (`x-sap-auth-type: "basic"`) - handled locally (no cloud connection needed)
- **Service key requests** (`x-sap-destination: "sk"`) - proxied to cloud-llm-hub with JWT token from auth-broker

## Purpose

Enable local MCP clients to connect to cloud ABAP systems through `cloud-llm-hub` with automatic JWT token management via `@mcp-abap-adt/auth-broker`.

## Features

- ✅ **Intelligent Routing** - Automatically routes requests based on authentication headers
- ✅ **JWT Token Management** - Automatic token retrieval, caching, and refresh via auth-broker
- ✅ **Error Handling** - Retry logic, circuit breaker, and comprehensive error handling
- ✅ **Connection Pooling** - Efficient connection caching and reuse
- ✅ **Multiple Transport Modes** - HTTP, SSE, and stdio support
- ✅ **Configuration Flexibility** - Environment variables, config files, or defaults

## Quick Start

### Installation

```bash
npm install -g @mcp-abap-adt/proxy
```

### Basic Usage

```bash
# Set cloud-llm-hub URL
export CLOUD_LLM_HUB_URL="https://cloud-llm-hub.example.com"

# Start proxy server
mcp-abap-adt-proxy
```

### Client Configuration (Cline)

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

## Documentation

- **[Configuration Guide](./doc/CONFIGURATION.md)** - Complete configuration reference
- **[Usage Examples](./doc/USAGE.md)** - Practical usage examples and patterns
- **[API Documentation](./doc/API.md)** - API reference and interfaces
- **[Architecture](./doc/ARCHITECTURE.md)** - System architecture and design
- **[Troubleshooting](./doc/TROUBLESHOOTING.md)** - Common issues and solutions
- **[Roadmap](./ROADMAP.md)** - Development roadmap and progress

## Routing Strategies

### Direct Cloud Routing

For requests with `x-sap-destination` (not "sk"), routes directly to cloud ABAP:

```json
{
  "headers": {
    "x-sap-destination": "S4HANA_E19"
  }
}
```

### Local Basic Auth

For requests with `x-sap-auth-type: "basic"`, handles locally:

```json
{
  "headers": {
    "x-sap-url": "https://abap-system.com",
    "x-sap-auth-type": "basic",
    "x-sap-login": "username",
    "x-sap-password": "password"
  }
}
```

### Cloud LLM Hub Proxy

For requests with `x-sap-destination: "sk"`, proxies to cloud-llm-hub:

```json
{
  "headers": {
    "x-sap-destination": "sk"
  }
}
```

## Configuration

### Environment Variables

```bash
export CLOUD_LLM_HUB_URL="https://cloud-llm-hub.example.com"
export MCP_HTTP_PORT=3001
export LOG_LEVEL=info
```

### Configuration File

Create `mcp-proxy-config.json`:

```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com",
  "httpPort": 3001,
  "logLevel": "info",
  "maxRetries": 3,
  "circuitBreakerThreshold": 5
}
```

See [Configuration Guide](./doc/CONFIGURATION.md) for complete options.

## Error Handling & Resilience

- **Retry Logic** - Exponential backoff for failed requests
- **Circuit Breaker** - Prevents cascading failures
- **Token Refresh** - Automatic token refresh on expiration
- **Connection Pooling** - Efficient resource management
- **Request Timeouts** - Configurable timeout handling

## Requirements

- Node.js >= 18.0.0
- npm >= 9.0.0

## Development Status

✅ **Core Features Complete** - Phases 1-7 and 9 implemented

- ✅ Phase 1: Project Setup & Foundation
- ✅ Phase 2: Request Interception & Analysis
- ✅ Phase 3: Direct Cloud Routing
- ✅ Phase 4: Basic Auth Handling
- ✅ Phase 5: Cloud Proxy with JWT
- ✅ Phase 6: Configuration & Environment
- ✅ Phase 7: Error Handling & Resilience
- ✅ Phase 9: Documentation

🚧 **Future Work** - Phases 8, 10, 11 pending

- ⏳ Phase 8: Testing
- ⏳ Phase 10: Performance & Optimization
- ⏳ Phase 11: Deployment & Publishing

See [ROADMAP.md](./ROADMAP.md) for details.

## License

MIT

## Links

- **Repository**: https://github.com/fr0ster/mcp-abap-adt-proxy
- **Issues**: https://github.com/fr0ster/mcp-abap-adt-proxy/issues
- **Related Packages**:
  - [@mcp-abap-adt/auth-broker](https://github.com/fr0ster/mcp-abap-adt-auth-broker)
  - [@mcp-abap-adt/connection](https://github.com/fr0ster/mcp-abap-adt-connection)
  - [@mcp-abap-adt/header-validator](https://github.com/fr0ster/mcp-abap-adt-header-validator)


# @mcp-abap-adt/proxy

MCP proxy server for SAP ABAP ADT - proxies local requests to cloud-llm-hub with JWT authentication.

## Overview

This package acts as a simple proxy between local MCP clients (like Cline) and any MCP server. It intercepts MCP requests, adds JWT authentication tokens, and forwards them to the target MCP server. The MCP server URL is obtained from the service key for the BTP destination.

## Purpose

Enable local MCP clients to connect to remote MCP servers (like `cloud-llm-hub`) with automatic JWT token management via `@mcp-abap-adt/auth-broker`. The proxy adds authentication headers and forwards requests transparently.

## Features

- ✅ **JWT Token Management** - Automatic token retrieval, caching, and refresh via auth-broker
- ✅ **Service Key Based** - MCP server URL is obtained from service key for BTP destination
- ✅ **Error Handling** - Retry logic, circuit breaker, and comprehensive error handling
- ✅ **Multiple Transport Modes** - HTTP, SSE, and stdio support
- ✅ **Configuration Flexibility** - Environment variables, config files, or defaults

## Quick Start

### Installation

```bash
npm install -g @mcp-abap-adt/proxy
```

### Basic Usage

```bash
# Start proxy server (in-memory session storage, secure)
mcp-abap-adt-proxy

# With command line overrides
mcp-abap-adt-proxy --btp=ai --mcp=trial

# Enable file-based session storage (persists tokens to disk)
mcp-abap-adt-proxy --unsafe

# With all options
mcp-abap-adt-proxy --btp=ai --mcp=trial --unsafe
```

### Client Configuration (Cline)

The proxy uses two service keys (URLs are obtained from service keys):

```json
{
  "mcpServers": {
    "mcp-abap-adt-proxy": {
      "disabled": false,
      "timeout": 60,
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp/stream/http",
      "headers": {
        "x-btp-destination": "btp-cloud",
        "x-mcp-destination": "sap-abap"
      }
    }
  }
}
```

**Required Headers:**
- `x-btp-destination` - Destination name for BTP Cloud authorization token and MCP server URL (required, for `Authorization: Bearer` header and to get MCP server URL from service key)

**Optional Headers:**
- `x-mcp-destination` - Destination name for SAP ABAP connection (optional, provides SAP token and configuration)

**Command Line Overrides:**
- `--btp=<destination>` - Overrides `x-btp-destination` header (required if header is missing, takes precedence)
- `--mcp=<destination>` - Overrides `x-mcp-destination` header (optional, takes precedence, works even if header is missing)
- `--unsafe` - Enables file-based session storage (persists tokens to disk). By default, sessions are stored in-memory (secure, lost on restart)

**How It Works:**
1. `x-btp-destination` (or `--btp`) → Gets JWT token from auth-broker → Adds `Authorization: Bearer <token>` header
2. `x-mcp-destination` (or `--mcp`) → Gets JWT token and SAP config from auth-broker → Adds SAP headers (`x-sap-jwt-token`, `x-sap-url`, etc.)

## Documentation

- **[Configuration Guide](./doc/CONFIGURATION.md)** - Complete configuration reference
- **[Usage Examples](./doc/USAGE.md)** - Practical usage examples and patterns
- **[API Documentation](./doc/API.md)** - API reference and interfaces
- **[Architecture](./doc/ARCHITECTURE.md)** - System architecture and design
- **[Troubleshooting](./doc/TROUBLESHOOTING.md)** - Common issues and solutions
- **[Roadmap](./ROADMAP.md)** - Development roadmap and progress

## How It Works

The proxy performs the following steps for each request:

1. **Extract Headers**: Reads `x-btp-destination` (required) and `x-mcp-destination` (optional)
2. **Apply Command Line Overrides**: `--btp` and `--mcp` parameters override headers (if provided)
3. **Validate Required Headers**: Returns error if `x-btp-destination` (or `--btp`) is missing
4. **Get BTP Cloud Token**: Retrieves JWT token for BTP Cloud authorization from `x-btp-destination` (or `--btp`)
5. **Get MCP Server URL**: Retrieves MCP server URL from service key for `x-btp-destination` (or `--btp`) via auth-broker
6. **Get SAP ABAP Config** (if provided): If `x-mcp-destination` (or `--mcp`) is provided, retrieves JWT token and SAP configuration (URL, client, etc.)
7. **Build Request**: 
   - Adds `Authorization: Bearer <token>` from `x-btp-destination` (or `--btp`) - **always added**
   - Adds SAP headers (`x-sap-jwt-token`, `x-sap-url`, etc.) from `x-mcp-destination` (or `--mcp`) - **only if provided**
8. **Forward Request**: Sends request to MCP server URL from service key (with `/mcp/stream/http` endpoint)
9. **Return Response**: Forwards the response back to the client

### Example Request Flow

```
Cline → Proxy (adds BTP token + SAP config) → Target MCP Server → Proxy → Cline
```

The proxy is transparent - it only adds authentication headers and forwards requests.

## Configuration

### Environment Variables

```bash
export CLOUD_LLM_HUB_URL="https://cloud-llm-hub.example.com"
export MCP_HTTP_PORT=3001
export LOG_LEVEL=info
export MCP_PROXY_UNSAFE=true  # Enable file-based session storage (optional)
```

### Configuration File

Create `mcp-proxy-config.json`:

```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com",
  "httpPort": 3001,
  "logLevel": "info",
  "maxRetries": 3,
  "circuitBreakerThreshold": 5,
  "unsafe": false
}
```

**Session Storage:**
- `unsafe: false` (default) - Session data stored in-memory (secure, lost on restart)
- `unsafe: true` - Session data persisted to disk (tokens saved to `.env` files)

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

✅ **Core Features Complete**

- ✅ Project Setup & Foundation
- ✅ Request Interception & Analysis
- ✅ JWT Token Management & Proxy Forwarding
- ✅ Configuration & Environment
- ✅ Error Handling & Resilience
- ✅ Documentation

🚧 **Future Work**

- ⏳ Unit Tests
- ⏳ Performance & Optimization
- ⏳ Deployment & Publishing

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


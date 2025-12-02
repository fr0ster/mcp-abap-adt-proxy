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

**Required Headers (one of the following):**
- `x-btp-destination` - Destination name for BTP Cloud authorization token and MCP server URL (for BTP authentication mode)
- `x-mcp-destination` - Destination name for SAP ABAP connection (for local testing mode without BTP)
- `x-mcp-url` - Direct MCP server URL (for local testing mode without authentication)

**Optional Headers:**
- `x-mcp-destination` - Destination name for SAP ABAP connection (optional, provides SAP token and configuration when used with BTP)

**Command Line Overrides:**
- `--btp=<destination>` - Overrides `x-btp-destination` header (for BTP authentication mode, takes precedence)
- `--mcp=<destination>` - Overrides `x-mcp-destination` header (for local testing or SAP config, takes precedence)
- `--mcp-url=<url>` - Direct MCP server URL (for local testing without authentication, takes precedence)
- `--unsafe` - Enables file-based session storage (persists tokens to disk). By default, sessions are stored in-memory (secure, lost on restart)

**How It Works:**

**BTP Authentication Mode** (with `x-btp-destination` or `--btp`):
1. `x-btp-destination` (or `--btp`) → Gets JWT token from auth-broker → Adds `Authorization: Bearer <token>` header
2. `x-mcp-destination` (or `--mcp`) → Gets JWT token and SAP config from auth-broker → Adds SAP headers (`x-sap-jwt-token`, `x-sap-url`, etc.)
3. MCP server URL obtained from service key for `x-btp-destination`

**Local Testing Mode** (with only `x-mcp-destination`/`--mcp` or `x-mcp-url`/`--mcp-url`):
1. `x-mcp-url` (or `--mcp-url`) → Direct URL to MCP server (no authentication)
2. `x-mcp-destination` (or `--mcp`) → Gets MCP server URL from service key for MCP destination (optional token)
3. No BTP authentication required - enables local integration testing

## Documentation

- **[Configuration Guide](./doc/CONFIGURATION.md)** - Complete configuration reference
- **[Usage Examples](./doc/USAGE.md)** - Practical usage examples and patterns
- **[API Documentation](./doc/API.md)** - API reference and interfaces
- **[Architecture](./doc/ARCHITECTURE.md)** - System architecture and design
- **[Troubleshooting](./doc/TROUBLESHOOTING.md)** - Common issues and solutions
- **[Roadmap](./ROADMAP.md)** - Development roadmap and progress

## How It Works

The proxy performs the following steps for each request:

1. **Extract Headers**: Reads `x-btp-destination`, `x-mcp-destination`, and `x-mcp-url` headers
2. **Apply Command Line Overrides**: `--btp`, `--mcp`, and `--mcp-url` parameters override headers (if provided)
3. **Validate Routing Requirements**: Requires at least one of: `x-btp-destination/--btp`, `x-mcp-destination/--mcp`, or `x-mcp-url/--mcp-url`
4. **Get MCP Server URL** (priority order):
   - From `x-mcp-url` header or `--mcp-url` parameter (direct URL)
   - From service key for `x-btp-destination` (if provided)
   - From service key for `x-mcp-destination` (if only MCP destination is provided)
5. **Get BTP Cloud Token** (if `x-btp-destination` or `--btp` is provided): Retrieves JWT token for BTP Cloud authorization
6. **Get SAP ABAP Config** (if `x-mcp-destination` or `--mcp` is provided): Retrieves JWT token and SAP configuration (URL, client, etc.) - optional, won't fail if unavailable
7. **Build Request**: 
   - Adds `Authorization: Bearer <token>` from `x-btp-destination` (or `--btp`) - **only if BTP destination is provided**
   - Adds SAP headers (`x-sap-jwt-token`, `x-sap-url`, etc.) from `x-mcp-destination` (or `--mcp`) - **only if provided**
8. **Forward Request**: Sends request to MCP server URL (from `x-mcp-url`, service key, or direct URL)
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

## Testing Tools

### Start Both Servers for Testing

Use the included script to start both `mcp-abap-adt` and `mcp-abap-adt-proxy` simultaneously:

```bash
# Using npm script
npm run test:servers

# Direct execution
node tools/start-servers.js

# With MCP destination (local testing)
node tools/start-servers.js --mcp=trial

# With SSE transport
node tools/start-servers.js --transport=sse
```

The script automatically:
- Starts ADT server on port 3000 (HTTP) or 3001 (SSE)
- Starts Proxy server on port 3001 (HTTP) or 3002 (SSE)
- Generates `mcpUrl` based on ADT server configuration
- Ensures both servers use the same transport protocol

See [tools/README.md](./tools/README.md) for complete documentation.

## Development Status

✅ **Core Features Complete**

- ✅ Project Setup & Foundation
- ✅ Request Interception & Analysis
- ✅ JWT Token Management & Proxy Forwarding
- ✅ Local Testing Mode (without BTP authentication)
- ✅ Configuration & Environment
- ✅ Error Handling & Resilience
- ✅ Testing Tools (`tools/start-servers.js`)
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


# @mcp-abap-adt/proxy

MCP proxy server for SAP ABAP ADT - proxies local requests to MCP servers with JWT authentication.

## Overview

This package acts as a simple proxy between local MCP clients (like Cline) and any MCP server. It intercepts MCP requests, adds JWT authentication tokens, and forwards them to the target MCP server. The MCP server URL is obtained from the service key for the BTP destination.

## Purpose

Enable local MCP clients to connect to remote MCP servers with automatic JWT token management via `@mcp-abap-adt/auth-broker`. The proxy adds authentication headers and forwards requests transparently.

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

# With BTP destination
mcp-abap-adt-proxy --btp=ai

# With direct MCP URL (local testing)
mcp-abap-adt-proxy --mcp-url=http://localhost:3000/mcp

# Enable file-based session storage (persists tokens to disk)
mcp-abap-adt-proxy --btp=ai --unsafe
```

### Configuration

The proxy supports multiple configuration methods:

- **Command-line parameters** (highest priority)
- **YAML/JSON configuration files** - See [YAML Configuration Guide](./docs/YAML_CONFIG.md)
- **Environment variables**
- **Default values** (lowest priority)

**Quick Example (YAML config)**:
```bash
# Copy example config from documentation
cp docs/mcp-proxy-config.example.yaml mcp-proxy-config.yaml

# Edit mcp-proxy-config.yaml with your settings

# Run with config file
mcp-abap-adt-proxy --config=mcp-proxy-config.yaml
# Or short form:
mcp-abap-adt-proxy -c mcp-proxy-config.yaml
```

### Client Configuration

For detailed setup instructions for Cline and GitHub Copilot, see the **[Client Setup Guide](./docs/CLIENT_SETUP.md)**.

**Quick Example (Cline)**:

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

**Required Headers (one of the following):**
- `x-btp-destination` - Destination name for BTP Cloud authorization token and MCP server URL
- `x-mcp-url` - Direct MCP server URL (for local testing mode without authentication)

**Command Line Overrides:**
- `--btp=<destination>` - Overrides `x-btp-destination` header (for BTP authentication mode, takes precedence)
- `--mcp-url=<url>` - Direct MCP server URL (for local testing without authentication, takes precedence)
- `--unsafe` - Enables file-based session storage (persists tokens to disk). By default, sessions are stored in-memory (secure, lost on restart)

**How It Works:**

The proxy uses BTP/XSUAA authentication:

1. **BTP/XSUAA Authentication** (if `--btp` or `x-btp-destination` is present):
   - Uses `btpAuthBroker` with `ClientCredentialsProvider` (client_credentials grant type)
   - Injects/overwrites `Authorization: Bearer <token>` header
   - MCP server URL obtained from BTP destination service key
   - Service key format: contains `uaa` (url, clientid, clientsecret) and `abap.url` (MCP server URL)

**BTP Authentication Mode** (with `x-btp-destination` or `--btp`):
1. `x-btp-destination` (or `--btp`) → Gets JWT token from `btpAuthBroker` → Adds `Authorization: Bearer <token>` header
2. MCP server URL obtained from service key for `x-btp-destination`

**Local Testing Mode** (with `x-mcp-url` or `--mcp-url`):
1. `x-mcp-url` (or `--mcp-url`) → Direct URL to MCP server (no authentication)
2. No BTP authentication required - enables local integration testing

## Documentation

- **[Client Setup Guide](./docs/CLIENT_SETUP.md)** - Step-by-step setup for Cline and GitHub Copilot
- **[Configuration Guide](./docs/CONFIGURATION.md)** - Complete configuration reference
- **[YAML Configuration Guide](./docs/YAML_CONFIG.md)** - Using YAML/JSON configuration files
- **[Usage Examples](./docs/USAGE.md)** - Practical usage examples and patterns
- **[API Documentation](./docs/API.md)** - API reference and interfaces
- **[Architecture](./docs/ARCHITECTURE.md)** - System architecture and design
- **[Troubleshooting](./docs/TROUBLESHOOTING.md)** - Common issues and solutions
- **[Routing Logic Specification](./docs/ROUTING_LOGIC.md)** - Detailed routing logic and scenarios
- **[Implementation Analysis](./docs/IMPLEMENTATION_ANALYSIS.md)** - Current implementation analysis
- **[Roadmap](./ROADMAP.md)** - Development roadmap and progress

## How It Works

The proxy performs the following steps for each request:

1. **Extract Headers**: Reads `x-btp-destination` and `x-mcp-url` headers
2. **Apply Command Line Overrides**: `--btp` and `--mcp-url` parameters override headers (if provided)
3. **Validate Routing Requirements**: Requires at least one of: `x-btp-destination/--btp` or `x-mcp-url/--mcp-url`
4. **BTP Authentication** (if `x-btp-destination` or `--btp` is provided):
   - Uses `btpAuthBroker` with `ClientCredentialsProvider` (client_credentials grant type)
   - Retrieves JWT token from BTP destination service key
   - Injects/overwrites `Authorization: Bearer <token>` header
5. **Get MCP Server URL** (priority order):
   - From `x-mcp-url` header or `--mcp-url` parameter (direct URL)
   - From service key for `x-btp-destination` (if provided)
6. **Forward Request**: Sends request to MCP server URL with all injected headers
7. **Return Response**: Forwards the response back to the client

### Example Request Flow

```
Cline → Proxy (adds BTP token) → Target MCP Server → Proxy → Cline
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

See [Configuration Guide](./docs/CONFIGURATION.md) for complete options.

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
  - [@mcp-abap-adt/header-validator](https://github.com/fr0ster/mcp-abap-adt-header-validator)

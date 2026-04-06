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
        "x-sap-destination": "btp-cloud"
      }
    }
  }
}
```

**Required Headers:**
- `x-sap-destination` - Destination name for BTP Cloud authorization token and MCP server URL

**Command Line Overrides:**
- `--btp=<destination>` - Overrides `x-sap-destination` header (takes precedence)
- `--url=<url>` - Overrides MCP server URL (required if service key lacks URL)
- `--browser=<browser>` - Browser to use: `system` (default), `chrome`, `edge`, `firefox`, `headless`
- `--browser-auth-port=<port>` - Port for OAuth2 callback (default: 3333)
- `--unsafe` - Enables file-based session storage (persists tokens to disk). By default, sessions are stored in-memory (secure, lost on restart)

**Default Headers:**

MCP clients like Cline and Claude Code cannot set arbitrary request headers. Use default headers to inject SAP-specific headers (e.g. `x-sap-destination`, `x-sap-client`) that the target MCP server requires.

Client-supplied headers always take precedence over defaults.

Via YAML config (`defaultHeaders` map):
```yaml
btpDestination: mcp
targetUrl: https://example.com
defaultHeaders:
  x-sap-destination: S4HANA_E19
  x-sap-client: "100"
```

Via CLI (`--header`, repeatable):
```bash
mcp-abap-adt-proxy --btp=mcp --url=https://example.com \
  --header x-sap-destination=S4HANA_E19 \
  --header x-sap-client=100
```

**How It Works:**

The proxy uses BTP/XSUAA authentication:

1. **BTP Authentication** (if `--btp` or `x-sap-destination` is present):
   - Uses `AuthorizationCodeProvider` (browser-based OAuth2 flow)
   - **Eager Authentication**: Opens browser immediately on startup to get token
   - Injects/overwrites `Authorization: Bearer <token>` header
   - MCP server URL obtained from BTP destination service key OR injected via `--url`
   - Service key format: contains `uaa` (url, clientid, clientsecret)

**BTP Authentication Mode** (with `--btp`):
1. Proxy starts → Opens browser for login (Eager Auth) → Gets/Refreshes JWT token
2. `x-sap-destination` (or `--btp`) → Adds `Authorization: Bearer <token>` header
3. MCP server URL obtained from service key OR `--url` parameter

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

1. **Extract Headers**: Reads `x-sap-destination` header
2. **Apply Command Line Overrides**: `--btp` parameter overrides header (if provided)
3. **Validate Routing Requirements**: Requires `x-sap-destination/--btp`
4. **BTP Authentication** (if `x-sap-destination` or `--btp` is provided):
   - Uses `AuthorizationCodeProvider` (browser-based login)
   - **Eagerly** obtains token on startup (if configured via `--btp`)
   - Retrieves JWT token using cached refresh token or opens browser
   - Injects/overwrites `Authorization: Bearer <token>` header
5. **Get MCP Server URL**:
   - From service key for `x-sap-destination`
6. **Forward Request**: Sends request to MCP server URL with all injected headers
7. **Return Response**: Forwards the response back to the client

### Example Request Flow

```
Cline → Proxy (adds BTP token) → Target MCP Server → Proxy → Cline
```

The proxy is transparent - it only adds authentication headers and forwards requests.

## Configuration

### Configuration

### Environment Variables

```bash
export MCP_HTTP_PORT=3001
export LOG_LEVEL=info
export MCP_PROXY_UNSAFE=true  # Enable file-based session storage (optional)
export AUTH_BROKER_PATH=~/.config/mcp-abap-adt  # Optional base path for service-keys/sessions
```

`AUTH_BROKER_PATH` is treated as a base directory. The proxy resolves:
- `service-keys` from `<AUTH_BROKER_PATH>/service-keys`
- `sessions` from `<AUTH_BROKER_PATH>/sessions`

Defaults when `AUTH_BROKER_PATH` is not set:
- Unix/Linux/macOS: `~/.config/mcp-abap-adt/service-keys` and `~/.config/mcp-abap-adt/sessions`
- Windows: `%USERPROFILE%\\Documents\\mcp-abap-adt\\service-keys` and `%USERPROFILE%\\Documents\\mcp-abap-adt\\sessions`

### Configuration File

Create `mcp-proxy-config.json`:

```json
{
  "httpPort": 3001,
  "logLevel": "info",
  "maxRetries": 3,
  "circuitBreakerThreshold": 5,
  "unsafe": false
}
```

**Session Storage:**
- `unsafe: false` (default) - Session data stored in-memory (secure, lost on restart)
- `unsafe: true` - Session data persisted to disk (tokens saved under the session store path)

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

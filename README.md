# @mcp-abap-adt/proxy
[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://stand-with-ukraine.pp.ua)

MCP proxy server for SAP ABAP ADT - proxies local requests to MCP servers with JWT authentication.

## Overview

This package acts as a simple proxy between local MCP clients (like Cline) and any MCP server. It intercepts MCP requests, adds JWT authentication tokens, and forwards them to the target MCP server. The MCP server URL is obtained from the service key for the BTP destination.

## Purpose

Enable local MCP clients to connect to remote MCP servers with automatic JWT token management via `@mcp-abap-adt/auth-broker`. The proxy adds authentication headers and forwards requests transparently.

## Features

- ✅ **One shared credential** - the token is the auth-broker's business: it caches, knows expiry and renews behind the call. The proxy holds no token of its own
- ✅ **Service Key Based** - MCP server URL is obtained from service key for BTP destination
- ✅ **Transparent forwarding** - the client's headers go through as sent; the proxy answers for the `Authorization` header and nothing else
- ✅ **Error Handling** - token acquisition is retried with exponential backoff when the failure can get better; clear messages when it cannot
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

## Two commands

The package installs two binaries, for two different jobs.

| Command | What it is for |
|---|---|
| `mcp-abap-adt-proxy` | **Be** a proxy. A client points at it and its requests are authenticated and forwarded. |
| `mcp-abap-adt-proxy-mcp` | **Manage** proxies. Speaks MCP over stdio; its tools start and stop proxies on demand. |

### The management mode

Register it like any other MCP server:

```json
{
  "mcpServers": {
    "abap-proxy": { "command": "mcp-abap-adt-proxy-mcp" }
  }
}
```

It works from the proxy configs you already keep:

```
~/.config/mcp-abap-adt/proxy/<name>.yaml     (Windows: Documents\mcp-abap-adt\proxy\)
```

These are the same files `mcp-abap-adt-proxy --config <file>` takes. Starting a
proxy is therefore **choosing a name**, not assembling settings — and
credentials stay in the config, resolved through `${VAR}` interpolation, rather
than travelling through a tool call.

| Tool | What it does |
|---|---|
| `proxy_configs` | Lists the configs available, by the name `proxy_start` takes. Call it first — the names cannot be guessed. |
| `proxy_start` | Starts a proxy from one of those configs and returns the URL it bound. The **port is not taken from the config**: a free one is bound instead. |
| `proxy_stop` | Stops a proxy this session started, freeing its port and releasing its credential. Proxies started by other sessions are never touched. |
| `proxy_status` | Lists this session's proxies and any others on this machine. Records whose process has died are pruned when read, so it cannot report a ghost. |

**The config name is the unit, not the destination.** Several configs commonly
name the same `btpDestination` and differ in target URL and headers — a
destination cannot tell them apart.

**Every proxy runs inside the management process.** Closing the session — or
`SIGINT`, or `SIGTERM` — stops all of them and frees their ports. This is
deliberate: a spawned child would be orphaned by any signal the parent did not
forward and would go on holding its HTTP and OAuth callback ports.

A proxy nobody has used for 30 minutes stops itself. That is a backstop for a
client that finished and forgot, not a substitute for `proxy_stop` — which is
why the tool descriptions say so, and say it again beside the URL.

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
- `--browser-auth-port=<port>` - Port for the OAuth2 callback (default: 3333). Bound only while you are logging in, then released — see [How long the callback port is held](./docs/CONFIGURATION.md#how-long-the-callback-port-is-held)
- `--unsafe` - Enables file-based session storage (persists tokens to disk). By default, sessions are stored in-memory (secure, lost on restart)

**Default Headers:**

MCP clients like Cline and Claude Code cannot set arbitrary request headers. Use default headers to inject SAP-specific headers (e.g. `x-sap-destination`, `x-sap-client`) that the target MCP server requires.

Precedence: client-supplied request headers always win over `defaultHeaders`. `Authorization` is the exception — it is always managed by the proxy (replaced with the destination JWT) and **cannot** be set via `defaultHeaders`.

Via YAML config (`defaultHeaders` map):
```yaml
btpDestination: mcp
targetUrl: https://example.com
defaultHeaders:
  x-sap-destination: S4HANA_E19
  x-sap-client: "100"
```

**Per-user ABAP credentials.** `defaultHeaders` is the supported place to supply your own SAP login/password for on-premise / `NoAuthentication` destinations. The upstream `cloud-llm-hub` is a **shared** server with no default service user, so it expects each caller's own `x-sap-login` / `x-sap-password` on every request. Because the proxy runs **locally on each user's machine**, it carries *your* identity.

Do not hardcode secrets. Reference environment variables with `${VAR}` (or `${VAR:-default}`); values are resolved from `process.env` or an explicitly-pointed `.env` file:

```yaml
btpDestination: mcp
envFile: secrets.env            # resolved relative to this config file's dir
defaultHeaders:
  x-sap-destination: S4HANA_E19
  x-sap-login: ${SAP_USER}
  x-sap-password: ${SAP_PASSWORD}
```

`secrets.env` (user-local, `chmod 600`, never committed):

```dotenv
SAP_USER=MY_SAP_USER
SAP_PASSWORD=my-sap-password
```

Resolution order is `process.env` → `.env` → `${VAR:-default}`. `process.env` wins; an unresolved `${VAR}` without a default fails the proxy at startup. Override the `.env` path at launch with `--env-file <path>`. This closes both auth layers from one local config: the **service layer** (`Authorization: Bearer <JWT>`, from the destination service key) and the **ABAP layer** (`x-sap-login` / `x-sap-password`).

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

- 🚚 **[Migration to 4.0](./docs/MIGRATION-4.0.md)** — the contracts leave the umbrella, an SSE response streams and carries your headers, `getJwtToken()` is replaced, the circuit breaker is gone

- **[Client Setup Guide](./docs/CLIENT_SETUP.md)** - Step-by-step setup for Cline and GitHub Copilot
- **[Configuration Guide](./docs/CONFIGURATION.md)** - Complete configuration reference
- **[YAML Configuration Guide](./docs/YAML_CONFIG.md)** - Using YAML/JSON configuration files
- **[Usage Examples](./docs/USAGE.md)** - Practical usage examples and patterns
- **[API Documentation](./docs/API.md)** - API reference and interfaces
- **[Architecture](./docs/ARCHITECTURE.md)** - System architecture and design
- **[Troubleshooting](./docs/TROUBLESHOOTING.md)** - Common issues and solutions
- **[Routing Logic Specification](./docs/ROUTING_LOGIC.md)** - Detailed routing logic and scenarios
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
  "unsafe": false
}
```

**Session Storage:**
- `unsafe: false` (default) - Session data stored in-memory (secure, lost on restart)
- `unsafe: true` - Session data persisted to disk (tokens saved under the session store path)

See [Configuration Guide](./docs/CONFIGURATION.md) for complete options.

## Error Handling & Resilience

- **Retry Logic** - exponential backoff while getting a token, for failures that can get better (5xx, network). A missing service key is not one of them and fails at once, with a message naming the file to create
- **Token Refresh** - handled by the credential, which is asked per request and renews behind the call
- **No circuit breaker** - it guarded the buffered forward that 4.0.0 removed. The forwarding path now streams, and there is nowhere to put one without buffering the response again. `circuitBreakerThreshold` and `circuitBreakerTimeout` are still accepted so existing configs load, and do nothing
- **Request Timeouts** - Configurable timeout handling

## Requirements

- Node.js >= 18.0.0
- npm >= 9.0.0

## Testing Tools

Verify a BTP destination's service key and token retrieval:

```bash
npm run test-destination
```

See [tools/README.md](./tools/README.md) for the available scripts.

## Development Status

✅ **Core Features Complete**

- ✅ Project Setup & Foundation
- ✅ Request Interception & Analysis
- ✅ JWT Token Management & Proxy Forwarding
- ✅ Configuration & Environment
- ✅ Error Handling & Resilience
- ✅ Testing Tools (`tools/`)
- ✅ Documentation

🚧 **Future Work**

- ⏳ Unit Tests
- ⏳ Performance & Optimization
- ⏳ Deployment & Publishing

See [ROADMAP.md](./ROADMAP.md) for details.

## License

**GNU General Public License v3.0 only** (`GPL-3.0-only`).
Earlier published versions were MIT and stay MIT — a licence change is not
retroactive.

Copyright © 2025–2026 Oleksii Kyslytsia

This program is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, version 3.

It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
PURPOSE. See [`LICENSE`](LICENSE) for the full text.

**What this means.** Running it, and using it on your own data, carries no
conditions at all. Distributing it, or a modified version of it, means passing on
the same freedoms — including the source. This is a finished tool rather than a
library to build on; the libraries it is built from are LGPL, so they can be
linked from programs under any licence.

## Links

- **Repository**: https://github.com/fr0ster/mcp-abap-adt-proxy
- **Issues**: https://github.com/fr0ster/mcp-abap-adt-proxy/issues
- **Related Packages**:
  - [@mcp-abap-adt/auth-broker](https://github.com/fr0ster/mcp-abap-adt-auth-broker)
  - [@mcp-abap-adt/header-validator](https://github.com/fr0ster/mcp-abap-adt-header-validator)

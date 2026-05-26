# Client Setup Guide

This guide provides step-by-step instructions for configuring Cline and GitHub Copilot to connect to MCP servers through the proxy.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Cline Configuration](#cline-configuration)
- [GitHub Copilot Configuration](#github-copilot-configuration)
- [Configuration Scenarios](#configuration-scenarios)
- [Troubleshooting](#troubleshooting)

## Prerequisites

1. **Install the proxy**:
   ```bash
   npm install -g @mcp-abap-adt/proxy
   ```

2. **Set up service keys** (for BTP destination-based authentication):
   - Place service key files in platform-specific directories:
     - **Unix/Linux/macOS**: `~/.config/mcp-abap-adt/service-keys/`
     - **Windows**: `%USERPROFILE%\Documents\mcp-abap-adt\service-keys\`
   - Service key files should be named after the destination (e.g., `btp-cloud.json`)

3. **Start the proxy server** (see scenarios below for specific commands)

## Cline Configuration

Cline uses the `streamableHttp` transport type and requires HTTP endpoint configuration.

### Basic Configuration File

Cline configuration is typically stored in:
- **macOS**: `~/Library/Application Support/Cline/cline.json`
- **Windows**: `%APPDATA%\Cline\cline.json`
- **Linux**: `~/.config/Cline/cline.json`

### Scenario 1: BTP Auth with Target URL Override

**Use Case**: Authenticate with a BTP destination's service key, but forward requests
to a different URL (e.g. direct OData testing or a non-standard MCP path).

**1. Start the proxy**:
```bash
mcp-abap-adt-proxy --btp=btp-cloud \
  --target-url=https://your-service.cfapps.eu10.hana.ondemand.com
```

**2. Configure Cline** (`cline.json`):
```json
{
  "mcpServers": {
    "mcp-abap-adt-proxy": {
      "disabled": false,
      "timeout": 60,
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp/stream/http",
      "headers": {
        "x-sap-destination": "btp-cloud",
        "x-target-url": "https://your-service.cfapps.eu10.hana.ondemand.com"
      }
    }
  }
}
```

**What happens**:
- Proxy obtains a BTP token from the `btp-cloud` service key
- Forwards requests to `x-target-url` instead of the key's `abap.url`, with `Authorization: Bearer <token>`

### Scenario 2: BTP MCP Server with BTP Authentication

**Use Case**: Connect to an MCP server deployed on SAP BTP that requires BTP authentication.

**1. Set up BTP service key**:
   - Create service key file: `~/.config/mcp-abap-adt/service-keys/btp-cloud.json`
   ```json
   {
     "uaa": {
       "url": "https://your-uaa-url.authentication.eu10.hana.ondemand.com",
       "clientid": "your-client-id",
       "clientsecret": "your-client-secret"
     },
     "abap": {
       "url": "https://mcp-server.cfapps.eu10.hana.ondemand.com"
     }
   }
   ```

**2. Start the proxy**:
```bash
mcp-abap-adt-proxy --btp=btp-cloud
```

**3. Configure Cline** (`cline.json`):
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

**Alternative: Use command-line override** (simpler, no headers needed):
```bash
# Start proxy with command-line overrides
mcp-abap-adt-proxy --btp=btp-cloud
```

```json
{
  "mcpServers": {
    "mcp-abap-adt-proxy": {
      "disabled": false,
      "timeout": 60,
      "type": "streamableHttp",
      "url": "http://localhost:3001/mcp/stream/http"
    }
  }
}
```

**What happens**:
- Proxy gets BTP token from `btp-cloud` destination
- Adds `Authorization: Bearer <token>` header
- Gets MCP server URL from service key (`abap.url`)
- Forwards request to MCP server on BTP

## GitHub Copilot Configuration

GitHub Copilot supports multiple transport types. The configuration depends on your setup.

### Configuration File Location

GitHub Copilot configuration is typically stored in:
- **macOS**: `~/Library/Application Support/GitHub Copilot/settings.json`
- **Windows**: `%APPDATA%\GitHub Copilot\settings.json`
- **Linux**: `~/.config/GitHub Copilot/settings.json`

### Scenario 1: HTTP Transport (Recommended)

**1. Start the proxy** (same as Cline scenarios above):
```bash
mcp-abap-adt-proxy --btp=btp-cloud
```

**2. Configure GitHub Copilot** (`settings.json`):
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

### Scenario 2: SSE Transport

**1. Start the proxy with SSE transport**:
```bash
mcp-abap-adt-proxy --transport=sse --btp=btp-cloud
```

**2. Configure GitHub Copilot** (`settings.json`):
```json
{
  "mcpServers": {
    "mcp-abap-adt-proxy": {
      "disabled": false,
      "timeout": 60,
      "type": "sse",
      "url": "http://localhost:3002",
      "headers": {
        "x-sap-destination": "btp-cloud"
      }
    }
  }
}
```

**Note**: SSE transport uses port 3002 by default (HTTP uses 3001).

### Scenario 3: Stdio Transport

**1. Start the proxy with stdio transport**:
```bash
mcp-abap-adt-proxy --transport=stdio --btp=btp-cloud
```

**2. Configure GitHub Copilot** (`settings.json`):
```json
{
  "mcpServers": {
    "mcp-abap-adt-proxy": {
      "disabled": false,
      "timeout": 60,
      "type": "stdio",
      "command": "mcp-abap-adt-proxy",
      "args": [
        "--transport=stdio",
        "--btp=btp-cloud"
      ]
    }
  }
}
```

**Note**: For stdio transport, the destination must be provided via command-line arguments (`--btp`, `--target-url`), not headers.

## Configuration Scenarios Summary

| Scenario | BTP Auth | Proxy Command | Headers Required |
|----------|----------|---------------|------------------|
| BTP MCP | Yes | `--btp=<dest>` | `x-sap-destination` |
| BTP MCP + explicit URL | Yes | `--btp=<dest> --target-url=<url>` | `x-sap-destination`, `x-target-url` |

## Advanced Configuration

### Using Environment Variables

You can configure the proxy using environment variables:

```bash
export MCP_HTTP_PORT=8080
export LOG_LEVEL=debug
mcp-abap-adt-proxy --btp=btp-cloud
```

### Using Configuration File

Create `mcp-proxy-config.json`:

```json
{
  "httpPort": 3001,
  "logLevel": "info",
  "maxRetries": 3,
  "requestTimeout": 60000,
  "circuitBreakerThreshold": 5
}
```

Start proxy:
```bash
mcp-abap-adt-proxy --btp=btp-cloud
```

### Session Storage

By default, sessions are stored in-memory (secure, lost on restart). To persist sessions to disk:

```bash
mcp-abap-adt-proxy --unsafe --btp=btp-cloud
```

**Warning**: `--unsafe` mode persists tokens to disk. Use only in development environments.

## Troubleshooting

### Issue: Connection Refused

**Symptoms**: Client cannot connect to proxy.

**Solutions**:
1. Verify proxy is running: `curl http://localhost:3001/mcp/stream/http`
2. Check port number matches configuration (default: 3001 for HTTP, 3002 for SSE)
3. Verify firewall settings allow connections to proxy port

### Issue: Authentication Failed

**Symptoms**: Proxy returns 401/403 errors.

**Solutions**:
1. Verify service key files exist in correct location
2. Check service key format (must contain `uaa` section for BTP destinations)
3. Verify destination names match between configuration and service key filenames
4. Enable verbose logging: `LOG_LEVEL=debug mcp-abap-adt-proxy ...`

### Issue: MCP Server Not Found

**Symptoms**: Proxy cannot reach target MCP server.

**Solutions**:
1. Verify `abap.url` in the service key (or `x-target-url`/`--target-url` override) points to the MCP server
2. Check network connectivity to MCP server
3. Verify MCP server is running and accessible
4. Verify the BTP destination (`--btp`/`x-sap-destination`) matches an existing service key

### Issue: Headers Not Passed Through

**Symptoms**: MCP server doesn't receive expected headers.

**Solutions**:
1. Remember: Only `x-sap-destination` is validated by proxy
2. All other headers are passed directly to MCP server
3. Verify headers are correctly formatted in client configuration
4. Check proxy logs for routing decisions

### Debug Mode

Enable verbose logging to troubleshoot issues:

```bash
# Environment variable
LOG_LEVEL=debug mcp-abap-adt-proxy --btp=<dest>
```

This will output detailed information about:
- Routing decisions
- Token retrieval
- Request forwarding
- Error details

## Quick Reference

### Proxy Command-Line Options

```bash
# Basic usage
mcp-abap-adt-proxy [options]

# Transport options
--transport=streamable-http  # HTTP transport (default, port 3001)
--transport=sse              # SSE transport (port 3002)
--transport=stdio            # Stdio transport

# Destination overrides
--btp=<destination>          # BTP destination name
--target-url=<url>           # Override target URL (auth still from --btp)

# Port configuration
--http-port=<port>           # HTTP port (default: 3001)
--sse-port=<port>            # SSE port (default: 3002)

# Session storage
--unsafe                     # Enable file-based session storage

# Help
--help                       # Show help message
```

### Client Configuration Headers

| Header | Required | Description |
|--------|----------|-------------|
| `x-sap-destination` | Required* | BTP destination name for authentication |
| `x-target-url` | Optional | Override the target URL (auth still from the BTP destination) |

\* `x-sap-destination` (or the `--btp` command-line parameter) must be provided.

### Service Key Locations

- **Unix/Linux/macOS**: `~/.config/mcp-abap-adt/service-keys/<destination>.json`
- **Windows**: `%USERPROFILE%\Documents\mcp-abap-adt\service-keys\<destination>.json`

## Additional Resources

- [Configuration Guide](./CONFIGURATION.md) - Complete configuration reference
- [Usage Examples](./USAGE.md) - More usage examples
- [Routing Logic](./ROUTING_LOGIC.md) - Detailed routing logic
- [Troubleshooting Guide](./TROUBLESHOOTING.md) - Common issues and solutions

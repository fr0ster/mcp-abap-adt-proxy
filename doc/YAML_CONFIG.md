# YAML Configuration Guide

The MCP ABAP ADT Proxy supports loading configuration from YAML or JSON files, providing a convenient alternative to command-line parameters and environment variables.

## Quick Start

1. Copy the example configuration file:
   ```bash
   cp doc/mcp-proxy-config.example.yaml mcp-proxy-config.yaml
   ```
   Or from the project root:
   ```bash
   cp mcp-proxy-config.example.yaml mcp-proxy-config.yaml
   ```

2. Customize the configuration for your environment

3. Run the proxy with the config file:
   ```bash
   mcp-abap-adt-proxy --config=mcp-proxy-config.yaml
   ```
   Or use the short form:
   ```bash
   mcp-abap-adt-proxy -c mcp-proxy-config.yaml
   ```

## Configuration File Locations

The proxy searches for configuration files in the following order:

1. **Explicit path** (via `--config` or `-c` parameter)
2. **Environment variable** (`MCP_PROXY_CONFIG`)
3. **Current directory**:
   - `mcp-proxy-config.yaml`
   - `mcp-proxy-config.yml`
   - `mcp-proxy-config.json`
   - `.mcp-proxy-config.yaml`
   - `.mcp-proxy-config.yml`
   - `.mcp-proxy-config.json`
4. **Home directory**:
   - `~/.mcp-proxy-config.yaml`
   - `~/.mcp-proxy-config.yml`
   - `~/.mcp-proxy-config.json`

## Configuration Priority

Configuration values are merged in the following priority order (highest to lowest):

1. **Command-line parameters** (e.g., `--btp=destination`)
2. **Environment variables**
3. **Configuration file** (YAML or JSON)
4. **Default values**

## YAML Configuration Template

```yaml
# MCP ABAP ADT Proxy Configuration
# Copy this file to mcp-proxy-config.yaml and customize for your environment

# Transport configuration
transport: http  # stdio | http | sse
httpPort: 3001
ssePort: 3002
httpHost: "0.0.0.0"
sseHost: "0.0.0.0"

# Destination overrides (optional - can be overridden by command-line parameters)
# BTP destination for Cloud authorization (Authorization: Bearer token)
# Uses service key from ~/.config/mcp-abap-adt/service-keys/<btpDestination>.json
btpDestination: "btp"

# MCP destination for SAP ABAP connection (x-sap-jwt-token, x-sap-url, etc.)
# Uses service key from ~/.config/mcp-abap-adt/service-keys/<mcpDestination>.json
mcpDestination: "mcp"

# Direct MCP server URL (alternative to mcpDestination, for local testing)
# mcpUrl: "https://your-mcp-server.com/mcp/stream/http"

# Session storage mode
unsafe: false  # If true, persists tokens to disk. If false, uses in-memory storage (secure)

# Error handling & resilience
maxRetries: 3
retryDelay: 1000  # milliseconds
requestTimeout: 60000  # milliseconds
circuitBreakerThreshold: 5
circuitBreakerTimeout: 60000  # milliseconds

# Logging
logLevel: "info"  # debug | info | warn | error

# Cloud LLM Hub URL (optional - usually obtained from service keys)
# cloudLlmHubUrl: "https://your-cloud-llm-hub.com"
```

## Configuration Examples

### Example 1: BTP Authentication Mode

```yaml
transport: http
httpPort: 3001
btpDestination: "btp"
mcpUrl: "https://your-mcp-server.com/mcp/stream/http"
```

Run with:
```bash
mcp-abap-adt-proxy --config=mcp-proxy-config.yaml
```

### Example 2: BTP + SAP ABAP Mode

```yaml
transport: http
httpPort: 3001
btpDestination: "btp"
mcpDestination: "mcp"
```

This configuration:
- Uses BTP destination `btp` for Cloud authorization (injects `Authorization: Bearer <token>`)
- Uses MCP destination `mcp` for SAP ABAP connection (injects `x-sap-jwt-token`, `x-sap-url`, etc.)

### Example 3: Local Testing Mode (No BTP)

```yaml
transport: http
httpPort: 3001
mcpDestination: "local"
# Or use direct URL:
# mcpUrl: "http://localhost:3000/mcp/stream/http"
```

### Example 4: SSE Transport

```yaml
transport: sse
ssePort: 3002
sseHost: "0.0.0.0"
btpDestination: "btp"
mcpDestination: "mcp"
```

### Example 5: Custom Error Handling

```yaml
transport: http
httpPort: 3001
btpDestination: "btp"
maxRetries: 5
retryDelay: 2000
requestTimeout: 120000
circuitBreakerThreshold: 10
circuitBreakerTimeout: 120000
```

## Configuration Fields Reference

### Transport Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `transport` | `string` | `"http"` | Transport type: `stdio`, `http`, `sse` |
| `httpPort` | `number` | `3001` | HTTP server port |
| `ssePort` | `number` | `3002` | SSE server port |
| `httpHost` | `string` | `"0.0.0.0"` | HTTP server host |
| `sseHost` | `string` | `"0.0.0.0"` | SSE server host |

### Destination Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `btpDestination` | `string` | `undefined` | BTP destination name (for Cloud authorization) |
| `mcpDestination` | `string` | `undefined` | MCP destination name (for SAP ABAP connection) |
| `mcpUrl` | `string` | `undefined` | Direct MCP server URL (alternative to `mcpDestination`) |

### Session Storage

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `unsafe` | `boolean` | `false` | If `true`, persists tokens to disk. If `false`, uses in-memory storage (secure) |

### Error Handling

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxRetries` | `number` | `3` | Maximum number of retry attempts |
| `retryDelay` | `number` | `1000` | Delay between retries (milliseconds) |
| `requestTimeout` | `number` | `60000` | Request timeout (milliseconds) |
| `circuitBreakerThreshold` | `number` | `5` | Number of failures before opening circuit breaker |
| `circuitBreakerTimeout` | `number` | `60000` | Circuit breaker timeout (milliseconds) |

### Logging

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `logLevel` | `string` | `"info"` | Log level: `debug`, `info`, `warn`, `error` |

## Using YAML Config in VS Code Debugging

You can use YAML configuration files when debugging in VS Code. The `launch.json` includes a configuration for this:

```json
{
  "type": "node",
  "request": "launch",
  "name": "MCP Proxy (YAML Config)",
  "program": "${workspaceFolder}/bin/mcp-abap-adt-proxy.js",
  "args": [
    "--config=mcp-proxy-config.yaml"
  ],
  "console": "integratedTerminal",
  "env": {
    "NODE_ENV": "development",
    "MCP_PROXY_VERBOSE": "true"
  }
}
```

## Security Notes

- **Never commit** your `mcp-proxy-config.yaml` file to version control (it's already in `.gitignore`)
- Use `.mcp-proxy-config.yaml` (with leading dot) for hidden configuration files
- Service keys are stored separately in `~/.config/mcp-abap-adt/service-keys/` (Unix) or `%USERPROFILE%\Documents\mcp-abap-adt\service-keys` (Windows)
- Set `unsafe: false` (default) to use secure in-memory session storage

## Troubleshooting

### Configuration file not found

If you get an error that the configuration file is not found:
1. Check that the file exists at the specified path
2. Verify the file extension (`.yaml`, `.yml`, or `.json`)
3. Check file permissions

### Configuration values not applied

Remember that command-line parameters take precedence over configuration files. If a value isn't being applied:
1. Check if you're passing the same parameter via command line
2. Verify the YAML syntax is correct (use a YAML validator)
3. Check for typos in field names

### YAML parsing errors

If you get YAML parsing errors:
1. Verify the YAML syntax (indentation matters!)
2. Check for special characters that need quoting
3. Ensure all strings are properly quoted if they contain special characters

## See Also

- [Configuration Guide](./CONFIGURATION.md) - General configuration documentation
- [Usage Guide](./USAGE.md) - Command-line usage examples
- [Client Setup Guide](./CLIENT_SETUP.md) - Setting up clients like Cline


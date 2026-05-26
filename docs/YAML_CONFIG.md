# YAML Configuration Guide

The MCP ABAP ADT Proxy supports loading configuration from YAML or JSON files, providing a convenient alternative to command-line parameters and environment variables.

## Quick Start

1. Copy the example configuration file:
   ```bash
   cp docs/mcp-proxy-config.example.yaml mcp-proxy-config.yaml
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

## Configuration File Location

There is **no auto-discovery**. The config file is loaded **only** when you pass it
explicitly via `--config` (or `-c`):

```bash
mcp-abap-adt-proxy --config=/path/to/mcp-proxy-config.yaml
```

Both `.yaml`/`.yml` and `.json` files are supported (format is detected by extension).

## Configuration Modes (mutually exclusive)

- **With `--config`**: configuration is loaded **only** from that file. Other CLI
  params (`--btp`, `--unsafe`, …) are ignored with a warning. Any value missing
  from the file falls back to its built-in default.
- **Without `--config`**: configuration comes from CLI parameters and environment
  variables only (see [CONFIGURATION.md](./CONFIGURATION.md)). The config file is
  not consulted.

## YAML Configuration Template

```yaml
# MCP ABAP ADT Proxy Configuration
# Load explicitly: mcp-abap-adt-proxy --config=mcp-proxy-config.yaml

# Transport configuration
transport: streamable-http  # stdio | http | streamable-http | sse
httpPort: 3001
httpHost: "127.0.0.1"
ssePort: 3002
sseHost: "127.0.0.1"

# BTP destination for Cloud authorization (Authorization: Bearer token).
# Must match a service key: ~/.config/mcp-abap-adt/service-keys/<btpDestination>.json
btpDestination: "btp"

# Target URL override (optional). Auth still comes from the service key above,
# but requests are forwarded here instead of the key's abap.url.
# targetUrl: "https://your-service.cfapps.eu10.hana.ondemand.com"

# Default headers injected into every forwarded request.
# Client-supplied headers take precedence over these.
defaultHeaders:
  x-sap-destination: "S4HANA_E19"

# OAuth2 login browser
browser: "system"      # system | headless | chrome | edge | firefox | none
browserAuthPort: 7777  # port for the local OAuth2 callback server

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
```

## Configuration Examples

### Example 1: BTP Authentication Mode

```yaml
transport: http
httpPort: 3001
btpDestination: "btp"
```

Run with:
```bash
mcp-abap-adt-proxy --config=mcp-proxy-config.yaml
```

### Example 2: BTP Auth with Target URL Override

```yaml
transport: http
httpPort: 3001
btpDestination: "btp"
targetUrl: "https://your-service.cfapps.eu10.hana.ondemand.com/v1"
```

Auth tokens come from the `btp` service key, but requests are forwarded to `targetUrl` instead of the URL in the service key.

### Example 3: BTP Auth with Default SAP Headers

```yaml
transport: streamable-http
httpPort: 3001
btpDestination: "btp"
defaultHeaders:
  x-sap-destination: "S4HANA_E19"
```

Every forwarded request gets the `x-sap-destination` header unless the client
already supplied one.

### Example 4: SSE Transport

```yaml
transport: sse
ssePort: 3002
sseHost: "127.0.0.1"
btpDestination: "btp"
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
| `transport` | `string` | `"streamable-http"` | Transport type: `stdio`, `http`, `streamable-http`, `sse` |
| `httpPort` | `number` | `3001` | HTTP server port |
| `ssePort` | `number` | `3002` | SSE server port |
| `httpHost` | `string` | `"127.0.0.1"` | HTTP server host (loopback by default; set `0.0.0.0` to expose) |
| `sseHost` | `string` | `"127.0.0.1"` | SSE server host (loopback by default; set `0.0.0.0` to expose) |

### Destination & Headers

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `btpDestination` | `string` | `undefined` | BTP destination name (for Cloud authorization). Must match a service key file. |
| `targetUrl` | `string` | `undefined` | Override target URL (uses auth from `btpDestination` but forwards to this URL) |
| `defaultHeaders` | `map` | `undefined` | Headers injected into every forwarded request; client headers take precedence |

### Authentication Browser

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `browser` | `string` | `"system"` | OAuth2 login browser: `system`, `headless`, `chrome`, `edge`, `firefox`, `none` |
| `browserAuthPort` | `number` | `undefined` | Port for the local OAuth2 callback server |

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
    "LOG_LEVEL": "debug"
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

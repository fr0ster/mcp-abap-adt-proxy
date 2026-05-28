# Configuration Guide

This guide explains how to configure the MCP ABAP ADT Proxy server.

## Configuration Methods

The proxy can be configured from a YAML/JSON file, from CLI parameters, or from a combination of both.

### Mode 1: Config file (`--config` / `-c`)

```bash
mcp-abap-adt-proxy --config=mcp-proxy-config.yaml
```

The file provides the baseline values. **CLI flags override values from the file** — handy for tweaking a single setting (port, browser mode, headers) on top of a stable config.

```bash
# YAML provides everything; CLI overrides browser mode and callback port:
mcp-abap-adt-proxy --config=mcp-proxy-config.yaml \
  --browser none --browser-auth-port 8888
```

When CLI values override the file, the proxy logs a `Note: CLI flags override values from <path>: ...` warning so the override is visible.

`--header key=value` flags are merged with `defaultHeaders` from the file (CLI keys win on conflict). All other overrides replace the file value entirely.

See [YAML Configuration Guide](./YAML_CONFIG.md) for the file format.

### Mode 2: CLI params + environment variables + defaults

Without `--config`, values come from CLI parameters, environment variables, and
built-in defaults. The config file is **not** consulted in this mode (and there is
no auto-discovery).

#### CLI parameters

| Flag | Description |
|------|-------------|
| `--btp=<destination>` | BTP destination for Cloud authorization |
| `--target-url=<url>` (alias `--url`) | Override target URL |
| `--unsafe` | Persist tokens to disk (default: in-memory) |
| `--header key=value` | Default header injected into every request (repeatable) |
| `--browser=<type>` | OAuth2 login browser: `system`, `headless`, `chrome`, `edge`, `firefox`, `none` |
| `--browser-auth-port=<port>` | Port for the local OAuth2 callback server |
| `--transport`, `--http-port`, `--http-host`, `--sse-port`, `--sse-host` | Transport settings |

Run `mcp-abap-adt-proxy --help` for the full list.

## Environment Variables

#### Server Configuration
- `MCP_HTTP_PORT` - HTTP server port (default: `3001`)
- `MCP_SSE_PORT` - SSE server port (default: `3002`)
- `MCP_HTTP_HOST` - HTTP server host (default: `127.0.0.1`)
- `MCP_SSE_HOST` - SSE server host (default: `127.0.0.1`)

> **Note:** The default is `127.0.0.1` (loopback only) — the proxy runs locally and holds
> auth tokens, so it does not listen on all interfaces by default. Set `httpHost`/`sseHost`
> (or `MCP_HTTP_HOST`/`MCP_SSE_HOST`) to `0.0.0.0` only if you deliberately need to expose
> it. (SSE additionally rejects non-local connections regardless of host.)
- `MCP_TRANSPORT` - Transport type: `stdio`, `http`, `streamable-http`, or `sse`

#### Session Storage
- `MCP_PROXY_UNSAFE` - Set to `"true"` to persist tokens to disk (default: in-memory)

#### Error Handling & Resilience
- `MCP_PROXY_MAX_RETRIES` - Maximum number of retry attempts (default: `3`)
- `MCP_PROXY_RETRY_DELAY` - Delay between retries in milliseconds (default: `1000`)
- `MCP_PROXY_REQUEST_TIMEOUT` - Request timeout in milliseconds (default: `60000`)
- `MCP_PROXY_CIRCUIT_BREAKER_THRESHOLD` - Number of failures before opening circuit breaker (default: `5`)
- `MCP_PROXY_CIRCUIT_BREAKER_TIMEOUT` - Timeout before attempting half-open state in milliseconds (default: `60000`)

#### Logging
- `LOG_LEVEL` - Logging level: `debug`, `info`, `warn`, `error` (default: `info`)

> **Note:** `--config` is the **only** way to load a config file. The
> `MCP_PROXY_CONFIG` environment variable is **not** honored.

## Configuration File

For the YAML/JSON config-file format and the full field reference, see the
[YAML Configuration Guide](./YAML_CONFIG.md). The file is loaded only via
`--config=<path>` (or `-c`).

## Examples

### Example 1: CLI parameters

```bash
mcp-abap-adt-proxy --transport=streamable-http --btp=btp \
  --header x-sap-destination=S4HANA_E19
```

### Example 2: Environment variables

```bash
export MCP_HTTP_PORT=8080
export LOG_LEVEL=debug
mcp-abap-adt-proxy --btp=btp
```

### Example 3: Config file

```bash
mcp-abap-adt-proxy --config=mcp-proxy-config.yaml
```

### Example 4: Config file with CLI overrides

```bash
mcp-abap-adt-proxy --config=mcp-proxy-config.yaml \
  --http-port=3003 --browser none --browser-auth-port=8888
```

YAML supplies the baseline; the four flags override `httpPort`, `browser`, and `browserAuthPort` from the file. See [YAML Configuration Guide](./YAML_CONFIG.md).

## Validation

The configuration is validated on server startup. Errors will prevent the server from starting, while warnings will be logged but won't stop the server.

### Common Validation Errors

- `MCP_HTTP_PORT must be between 1 and 65535` - Invalid port number
- `MCP_SSE_PORT must be between 1 and 65535` - Invalid port number
- `MCP_HTTP_PORT and MCP_SSE_PORT must be different` - Ports must be unique

### Common Validation Warnings

- `No BTP destination provided (--btp)` - Proxy won't work unless requests include an `x-sap-destination` header
- `MCP_PROXY_MAX_RETRIES should be between 0 and 10` - Retry count out of recommended range
- `MCP_PROXY_RETRY_DELAY should be between 0 and 60000ms` - Retry delay out of recommended range
- `MCP_PROXY_REQUEST_TIMEOUT should be between 1000 and 300000ms` - Timeout out of recommended range

## Best Practices

1. **Use a config file for stable setups** - Keep per-subaccount settings in a YAML file loaded via `--config`
2. **Use CLI params for quick overrides** - CLI flags override matching values from `--config` (handy for one-off tweaks like a different `--browser-auth-port`)
3. **Validate configuration** - Check logs for validation warnings on startup
4. **Set appropriate timeouts** - Adjust `requestTimeout` based on your network conditions
5. **Configure circuit breaker** - Adjust thresholds based on your reliability requirements

## Troubleshooting

### Server won't start

- Check configuration validation errors in logs
- Ensure port numbers are valid and not in use

### Proxy requests failing

- Verify the BTP destination (`--btp` or `btpDestination`) matches an existing service key
- Check network connectivity to the target service
- Review circuit breaker state in logs
- Check token expiration errors

### High latency

- Increase `requestTimeout` if requests are timing out
- Adjust `retryDelay` for faster retries
- Review circuit breaker settings


# Configuration Guide

This guide explains how to configure the MCP ABAP ADT Proxy server.

## Configuration Methods

The proxy supports three configuration methods (in order of precedence):

1. **Environment Variables** (highest priority)
2. **Configuration File** (`mcp-proxy-config.json`)
3. **Default Values** (lowest priority)

## Environment Variables

### Required Variables

- `CLOUD_LLM_HUB_URL` - URL of the cloud-llm-hub service
  - Example: `https://cloud-llm-hub.example.com`
  - **Note**: Only required if using proxy to cloud-llm-hub functionality

### Optional Variables

#### Server Configuration
- `MCP_HTTP_PORT` - HTTP server port (default: `3001`)
- `MCP_SSE_PORT` - SSE server port (default: `3002`)
- `MCP_HTTP_HOST` - HTTP server host (default: `0.0.0.0`)
- `MCP_SSE_HOST` - SSE server host (default: `0.0.0.0`)
- `MCP_TRANSPORT` - Transport type: `stdio`, `streamable-http`, or `sse` (default: `streamable-http`)

#### Error Handling & Resilience
- `MCP_PROXY_MAX_RETRIES` - Maximum number of retry attempts (default: `3`)
- `MCP_PROXY_RETRY_DELAY` - Delay between retries in milliseconds (default: `1000`)
- `MCP_PROXY_REQUEST_TIMEOUT` - Request timeout in milliseconds (default: `60000`)
- `MCP_PROXY_CIRCUIT_BREAKER_THRESHOLD` - Number of failures before opening circuit breaker (default: `5`)
- `MCP_PROXY_CIRCUIT_BREAKER_TIMEOUT` - Timeout before attempting half-open state in milliseconds (default: `60000`)

#### Logging
- `LOG_LEVEL` - Logging level: `debug`, `info`, `warn`, `error` (default: `info`)
- `DEBUG_HTTP_REQUESTS` - Enable HTTP request logging (default: `false`)

#### Configuration File
- `MCP_PROXY_CONFIG` - Path to configuration file (optional)

## Configuration File

Create a JSON configuration file named `mcp-proxy-config.json` in one of these locations:

1. Current working directory: `./mcp-proxy-config.json`
2. Current working directory (hidden): `./.mcp-proxy-config.json`
3. User home directory: `~/.mcp-proxy-config.json`

### Configuration File Format

```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com",
  "httpPort": 3001,
  "ssePort": 3002,
  "httpHost": "0.0.0.0",
  "sseHost": "0.0.0.0",
  "logLevel": "info",
  "maxRetries": 3,
  "retryDelay": 1000,
  "requestTimeout": 60000,
  "circuitBreakerThreshold": 5,
  "circuitBreakerTimeout": 60000
}
```

### Configuration File Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cloudLlmHubUrl` | string | `""` | URL of cloud-llm-hub service |
| `httpPort` | number | `3001` | HTTP server port |
| `ssePort` | number | `3002` | SSE server port |
| `httpHost` | string | `"0.0.0.0"` | HTTP server host |
| `sseHost` | string | `"0.0.0.0"` | SSE server host |
| `logLevel` | string | `"info"` | Logging level |
| `maxRetries` | number | `3` | Maximum retry attempts |
| `retryDelay` | number | `1000` | Retry delay in milliseconds |
| `requestTimeout` | number | `60000` | Request timeout in milliseconds |
| `circuitBreakerThreshold` | number | `5` | Circuit breaker failure threshold |
| `circuitBreakerTimeout` | number | `60000` | Circuit breaker timeout in milliseconds |

## Configuration Precedence

Environment variables **always override** configuration file values. This allows you to:

1. Set default values in the configuration file
2. Override specific values via environment variables
3. Use different configurations for different environments

## Examples

### Example 1: Environment Variables Only

```bash
export CLOUD_LLM_HUB_URL="https://cloud-llm-hub.example.com"
export MCP_HTTP_PORT=8080
export LOG_LEVEL=debug
mcp-abap-adt-proxy
```

### Example 2: Configuration File

Create `mcp-proxy-config.json`:

```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com",
  "httpPort": 3001,
  "logLevel": "info"
}
```

Run:
```bash
mcp-abap-adt-proxy
```

### Example 3: Mixed (File + Environment Override)

Create `mcp-proxy-config.json`:

```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com",
  "httpPort": 3001,
  "logLevel": "info"
}
```

Run with override:
```bash
export MCP_HTTP_PORT=8080
mcp-abap-adt-proxy
# Uses httpPort=8080 from env, other values from file
```

## Validation

The configuration is validated on server startup. Errors will prevent the server from starting, while warnings will be logged but won't stop the server.

### Common Validation Errors

- `CLOUD_LLM_HUB_URL must be a valid URL` - Invalid URL format
- `MCP_HTTP_PORT must be between 1 and 65535` - Invalid port number
- `MCP_HTTP_PORT and MCP_SSE_PORT must be different` - Ports must be unique

### Common Validation Warnings

- `CLOUD_LLM_HUB_URL is not set` - Proxy functionality won't work, but direct cloud and basic auth will
- `MCP_PROXY_MAX_RETRIES should be between 0 and 10` - Retry count out of recommended range

## Best Practices

1. **Use configuration files for defaults** - Set common values in `mcp-proxy-config.json`
2. **Use environment variables for overrides** - Override specific values per environment
3. **Validate configuration** - Check logs for validation warnings on startup
4. **Set appropriate timeouts** - Adjust `requestTimeout` based on your network conditions
5. **Configure circuit breaker** - Adjust thresholds based on your reliability requirements

## Troubleshooting

### Server won't start

- Check configuration validation errors in logs
- Verify all required environment variables are set
- Ensure port numbers are valid and not in use

### Proxy requests failing

- Verify `CLOUD_LLM_HUB_URL` is set correctly
- Check network connectivity to cloud-llm-hub
- Review circuit breaker state in logs
- Check token expiration errors

### High latency

- Increase `requestTimeout` if requests are timing out
- Adjust `retryDelay` for faster retries
- Review circuit breaker settings


# Troubleshooting Guide

This guide helps you diagnose and resolve common issues with `@mcp-abap-adt/proxy`.

## Common Issues

### 1. Server Won't Start

#### Error: "Configuration validation failed"

**Symptoms:**
- Server fails to start
- Error message about configuration validation

**Causes:**
- Missing required configuration
- Invalid configuration values
- Port conflicts

**Solutions:**

1. **Check the BTP destination:**
```bash
# A BTP destination is required (CLI --btp, header x-sap-destination, or btpDestination in config)
mcp-abap-adt-proxy --btp=btp-cloud
```

2. **Validate configuration file:**
```bash
# Check that the YAML config parses
npx js-yaml mcp-proxy-config.yaml
```

3. **Check port availability:**
```bash
# Check if port is in use
lsof -i :3001  # Linux/Mac
netstat -ano | findstr :3001  # Windows
```

4. **Review validation errors:**
```bash
# Enable debug logging to see validation details
export LOG_LEVEL=debug
mcp-abap-adt-proxy --btp=btp-cloud
```

#### Error: "Port already in use"

**Symptoms:**
- Server fails to start
- Error: "EADDRINUSE"

**Solutions:**

1. **Use different port:**
```bash
export MCP_HTTP_PORT=3002
mcp-abap-adt-proxy --btp=btp-cloud
```

2. **Kill process using port:**
```bash
# Find process
lsof -i :3001

# Kill process
kill -9 <PID>
```

#### Error: "Port N is already in use" naming your browserAuthPort

**Symptoms:**
- Startup fails with `Token provider error for <destination>: Port <n> is already in use. Please specify a different port or free the port.`
- The number is the one from `browserAuthPort` (or `--browser-auth-port`), not `httpPort`
- It often appears on the *second* start: the first run worked, you stopped it, and now the port is still taken

The callback port is only needed while you are logging in. It is bound when the
login window opens and released as soon as the authorization code has been
exchanged for a token — the proxy keeps running afterwards without it. So a
callback port that stays busy means something is still holding it.

**Diagnose — find out what actually holds it:**

```bash
# Linux
ss -ltnp | grep :7777
# macOS
lsof -nP -iTCP:7777 -sTCP:LISTEN
```

Four things it usually turns out to be:

1. **An unrelated program on the same number.** The proxy's callback port and
   another service's main port are easy to collide by accident. Check what the
   command line actually is before assuming it is a proxy.

2. **A proxy you thought you had stopped — in versions before 1.6.3.** The
   launcher forwarded only `SIGINT`, so `kill`, `pkill`, a closing terminal or
   an MCP client stopping the server killed the launcher and left the real
   server running. Look for it under its inner name, not the CLI name:

   ```bash
   ps -eo pid,ppid,args | grep '[d]ist/index.js'
   ```

   A parent PID of 1 (or `systemd --user`) means it was orphaned. Upgrade to
   1.6.3 or later, and kill any strays once:

   ```bash
   pkill -f 'proxy/dist/index.js'
   ```

3. **Another proxy still inside its login window.** The port is held for the
   entire interactive login, so two proxies configured with the same
   `browserAuthPort` cannot log in at the same time. This is expected. Give each
   config its own port, or complete one login before starting the next.

4. **A running proxy whose previous login leaked the socket — in versions before
   1.6.4.** A callback that arrived without a `code` parameter — a reloaded tab,
   a duplicate request, a port scanner — ended the login through a path that
   never closed the server, so a live proxy kept the port for the rest of its
   life. Unlike cause 2, the process is one you meant to be running, so it looks
   innocent. Fixed in 1.6.4 via `@mcp-abap-adt/auth-providers@1.2.0`.

   Since `auth-providers@2.0.0` such a request no longer ends the login at all:
   it is answered `400`, counted, and the login keeps waiting. If a login then
   times out, the error names the tally — `3 incomplete request(s) reached
   /callback and were ignored.` — which tells you something was probing the
   callback port while you were logging in.

**Note:** the main `httpPort` being free is not evidence that the proxy is gone,
but it does narrow things down. An orphaned server from before 1.6.3 held *both*
ports, so when only the callback port looks busy the culprit is one of the causes
that leaves the main port alone: an unrelated program on the same number (1), a
proxy still inside its login window (3), or — before 1.6.4 — a running proxy
whose earlier login leaked the socket (4).

### 2. Proxy Requests Failing

#### Error: "--btp parameter is required for stdio transport"

**Symptoms:**
- Server exits immediately on stdio transport
- Error type: `STDIO_DESTINATION_REQUIRED`

**Solutions:**

For stdio/SSE transports the destination cannot come from request headers, so it must
be provided on the command line (or in a config file):
```bash
mcp-abap-adt-proxy --transport=stdio --btp=btp-cloud
```

#### ~~Error: "Circuit breaker is open"~~ — cannot happen since 4.0.0

The circuit breaker was removed together with the buffered forward it guarded. A
target that keeps failing now fails visibly on every request instead of being
short-circuited, so there is no state to reset and nothing to tune.
`circuitBreakerThreshold` and `circuitBreakerTimeout` are still accepted in
configuration and do nothing.

What to look at instead when requests keep failing:

1. **Check network connectivity:**
```bash
ping cloud-llm-hub.example.com
```

2. **Check the retry log.** Token acquisition is retried on failures that can get
   better; each attempt logs `RETRY_ATTEMPT`, and the final failure logs
   `CREDENTIAL_HEADER_ERROR` with the reason.

#### Error: "Service key file not found for destination …" (or another token failure)

**Symptoms:**
- Proxy requests fail, or the standalone proxy exits at startup
- `CREDENTIAL_HEADER_ERROR` in the log

**Causes:**
- Service key not found. The proxy checks for it itself before asking the
  auth-broker, and says so in these words:
  ```
  Service key file not found for destination "sk".
  Please create service key file: sk.json
  Searched in:
    - /home/you/.config/mcp-abap-adt/service-keys
  ```
- Invalid or incomplete service key — auth-providers' `ValidationError`, naming
  the missing fields
- A browser login that did not complete — auth-providers' `BrowserAuthError`
  (timeout, the identity provider's refusal, a busy callback port, a browser
  that would not open)

Since the move to auth-broker 3, the provider's own error reaches the log as
it was raised; the broker no longer rewraps it into
`Token provider … error for <destination>`.

**Solutions:**

1. **Verify service key exists:**
```bash
# Unix
ls ~/.config/mcp-abap-adt/service-keys/sk.json

# Windows
dir %USERPROFILE%\Documents\mcp-abap-adt\service-keys\sk.json
```

2. **Validate service key format:**
```json
{
  "uaa": {
    "url": "https://uaa-url.com",
    "clientid": "client-id",
    "clientsecret": "client-secret"
  },
  "abap": {
    "url": "https://abap-url.com",
    "client": "100"
  }
}
```

3. **Check AuthBroker paths:**
```bash
export AUTH_BROKER_PATH="/custom/path"
# Service keys will be resolved from /custom/path/service-keys
# Sessions will be resolved from /custom/path/sessions
```

4. **Test authentication manually** — through the proxy's own path:
```bash
npm run test-destination -- sk
```

### 3. Routing Issues

#### Request routed incorrectly

**Symptoms:**
- Request goes to wrong destination
- Unexpected routing strategy

**Solutions:**

1. **Check headers:**
```bash
# Enable debug logging
export LOG_LEVEL=debug
```

2. **Verify header format:**
```json
{
  "headers": {
    "x-sap-destination": "sk"  // Must be lowercase "sk" for proxy
  }
}
```

3. **Review routing decision logs:**
```
[DEBUG] Routing decision made: { strategy: "proxy", destination: "sk" }
```

#### Unknown routing strategy

**Symptoms:**
- Error: "Unknown routing strategy"
- Request rejected

**Causes:**
- Missing required destination
- Neither `x-sap-destination` header nor `--btp` CLI parameter provided

**Solutions:**

1. **Provide a BTP destination:**
   - `x-sap-destination` header (HTTP/SSE), or
   - `--btp` CLI parameter / `btpDestination` in the config file

2. **Review header validation:**
```bash
# Check validation errors in logs
export LOG_LEVEL=debug
```

### 4. Connection Issues

#### Error: "Failed to connect to target server"

**Symptoms:**
- Proxy requests fail with connection errors

**Solutions:**

1. **Verify destination service key:**
```bash
# Check service key exists
ls ~/.config/mcp-abap-adt/service-keys/<destination>.json
```

2. **Check network connectivity:**
```bash
# Test target URL
curl -I https://your-mcp-server.com
```

### 5. Performance Issues

#### High Latency

**Symptoms:**
- Requests take too long
- Timeout errors

**Solutions:**

1. **Increase timeout:**
```json
{
  "requestTimeout": 120000
}
```

2. **Check network latency:**
```bash
ping cloud-llm-hub.example.com
```

3. **Review retry settings:**
```json
{
  "maxRetries": 2,  // Reduce retries for faster failure
  "retryDelay": 500  // Reduce delay
}
```

#### Memory Issues

**Symptoms:**
- High memory usage
- Server crashes

**Solutions:**

1. **Check connection cache size:**
```bash
# Connection cache auto-cleans after 100 entries
# Old connections are removed after 1 hour
```

2. **Reduce cache TTL:**
```typescript
// Modify in code if needed
const TOKEN_CACHE_TTL = 15 * 60 * 1000; // 15 minutes instead of 30
```

3. **Monitor connection count:**
```bash
# Check logs for connection creation
export LOG_LEVEL=debug
```

### 6. Token Issues

#### Token Expiration Errors

**Symptoms:**
- 401/403 errors
- "Token expired" messages

**Solutions:**

1. **Token renewal is the credential's, not the proxy's:**
   - The proxy keeps no token cache; it asks the destination's credential for
     a header on every request
   - The auth-broker's provider renews an expired token with the refresh token,
     or runs the browser login when there is none or it is refused
   - A 401 from the target is passed back to the client; the proxy does not
     retry the request

2. **With `--unsafe`**, the session file holds the service URL, the token and
   the refresh token — not the client secret, which stays in the service key.

3. **Verify service key:**
```bash
# Ensure service key has valid UAA credentials
npx sap-abap-auth auth -k sk.json
```

#### Token Not Found

**Symptoms:**
- "No authentication found for destination"

**Solutions:**

1. **Create service key file:**
```bash
# Place in platform-specific location
# Unix: ~/.config/mcp-abap-adt/service-keys/sk.json
# Windows: %USERPROFILE%\Documents\mcp-abap-adt\service-keys\sk.json
```

2. **Use custom path:**
```bash
export AUTH_BROKER_PATH="/custom/path"
# Supports both base path and explicit subfolder paths
# /custom/path -> /custom/path/service-keys
# /custom/path/service-keys -> /custom/path/service-keys
```

3. **Check file permissions:**
```bash
# Ensure file is readable
chmod 644 sk.json
```

## Debugging Tips

### Enable Debug Logging

```bash
export LOG_LEVEL=debug
mcp-abap-adt-proxy --btp=btp-cloud
```

### Check Routing Decisions

Look for logs like:
```
[DEBUG] Routing decision made: { strategy: "proxy", destination: "sk" }
```

### ~~Monitor Circuit Breaker~~ — removed in 4.0.0

There is no breaker to monitor. What is worth watching instead is
`RETRY_ATTEMPT`, logged while a token is being acquired, and
`CREDENTIAL_HEADER_ERROR` when it could not be.

### Check Connection Cache

Look for logs like:
```
[DEBUG] Creating new direct cloud connection
[DEBUG] Reusing cached direct cloud connection
```

### Verify Token Retrieval

Look for logs like:
```
[DEBUG] Asking the credential for a header
[INFO] [AuthBroker] Token saved for sk
```

## Getting Help

### Check Logs

Always check logs first:
```bash
# Enable debug logging
export LOG_LEVEL=debug
mcp-abap-adt-proxy 2>&1 | tee proxy.log
```

### Common Log Patterns

**Successful Request:**
```
[INFO] Request intercepted
[DEBUG] Routing decision made: { strategy: "proxy" }
[DEBUG] Proxied request completed
```

**Failed Request:**
```
[ERROR] Failed to proxy request to cloud-llm-hub
[ERROR] Circuit breaker opened due to failures
```

### Report Issues

When reporting issues, include:
1. Error messages from logs
2. Configuration (sanitized)
3. Request headers (sanitized)
4. Steps to reproduce
5. Environment details (OS, Node.js version)

## Best Practices

1. **Always provide a BTP destination** - via `--btp`, `x-sap-destination`, or `btpDestination` in config
2. **Monitor circuit breaker** - Check logs for circuit breaker state
3. **Use appropriate timeouts** - Set timeouts based on network conditions
4. **Keep service keys secure** - Never commit service keys to version control
5. **Enable debug logging** - Use debug mode for troubleshooting
6. **Check network connectivity** - Verify connectivity before troubleshooting
7. **Validate configuration** - Always validate config on startup

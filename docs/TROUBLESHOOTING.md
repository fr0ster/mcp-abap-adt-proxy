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

1. **Check required environment variables:**
```bash
# For proxy functionality, CLOUD_LLM_HUB_URL is required
export CLOUD_LLM_HUB_URL="https://cloud-llm-hub.example.com"
```

2. **Validate configuration file:**
```bash
# Check if config file is valid JSON
cat mcp-proxy-config.json | jq .
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
mcp-abap-adt-proxy
```

#### Error: "Port already in use"

**Symptoms:**
- Server fails to start
- Error: "EADDRINUSE"

**Solutions:**

1. **Use different port:**
```bash
export MCP_HTTP_PORT=3002
mcp-abap-adt-proxy
```

2. **Kill process using port:**
```bash
# Find process
lsof -i :3001

# Kill process
kill -9 <PID>
```

### 2. Proxy Requests Failing

#### Error: "Cloud LLM Hub URL not configured"

**Symptoms:**
- Proxy requests return error
- Error message about missing URL

**Solutions:**

1. **Set environment variable:**
```bash
export CLOUD_LLM_HUB_URL="https://cloud-llm-hub.example.com"
```

2. **Add to configuration file:**
```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com"
}
```

#### Error: "Circuit breaker is open"

**Symptoms:**
- Requests rejected immediately
- Error: "Service temporarily unavailable"

**Causes:**
- Too many failures to cloud-llm-hub
- Service is down or unreachable

**Solutions:**

1. **Check cloud-llm-hub status:**
```bash
curl https://cloud-llm-hub.example.com/health
```

2. **Reset circuit breaker:**
```bash
# Restart proxy server (circuit breaker resets on restart)
# Or wait for timeout period (default: 60 seconds)
```

3. **Adjust circuit breaker settings:**
```json
{
  "circuitBreakerThreshold": 10,
  "circuitBreakerTimeout": 120000
}
```

4. **Check network connectivity:**
```bash
ping cloud-llm-hub.example.com
```

#### Error: "Failed to get JWT token from auth-broker"

**Symptoms:**
- Proxy requests fail
- Error about JWT token

**Causes:**
- Service key not found
- Invalid service key
- AuthBroker configuration issue

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
export AUTH_BROKER_PATH="/custom/path/to/service-keys"
```

4. **Test authentication manually:**
```bash
npx sap-abap-auth auth -k sk.json
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
export DEBUG_HTTP_REQUESTS=true
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
[DEBUG] Routing decision made: { strategy: "proxy-cloud-llm-hub", destination: "sk" }
```

#### Unknown routing strategy

**Symptoms:**
- Error: "Unknown routing strategy"
- Request rejected

**Causes:**
- Missing required headers
- Invalid header combination

**Solutions:**

1. **Check required headers:**
   - For direct cloud: `x-sap-destination` (not "sk")
   - For basic auth: `x-sap-auth-type: "basic"` + `x-sap-url` + `x-sap-login` + `x-sap-password`
   - For proxy: `x-sap-destination: "sk"`

2. **Review header validation:**
```bash
# Check validation errors in logs
export LOG_LEVEL=debug
```

### 4. Connection Issues

#### Error: "Failed to connect to cloud ABAP"

**Symptoms:**
- Direct cloud requests fail
- Connection errors

**Solutions:**

1. **Verify destination service key:**
```bash
# Check service key exists
ls ~/.config/mcp-abap-adt/service-keys/S4HANA_E19.json
```

2. **Test connection manually:**
```bash
# Use connection package to test
npx @mcp-abap-adt/connection test -d S4HANA_E19
```

3. **Check network connectivity:**
```bash
# Test ABAP URL
curl -I https://your-abap-system.com
```

#### Error: "Failed to connect with basic auth"

**Symptoms:**
- Local basic auth requests fail
- Authentication errors

**Solutions:**

1. **Verify credentials:**
```json
{
  "x-sap-url": "https://abap-system.com",
  "x-sap-auth-type": "basic",
  "x-sap-login": "username",
  "x-sap-password": "password",
  "x-sap-client": "100"
}
```

2. **Test credentials manually:**
```bash
curl -u username:password https://abap-system.com/sap/bc/adt/discovery
```

3. **Check client number:**
```bash
# Verify client number is correct
# Some systems require specific client numbers
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

1. **Token refresh is automatic:**
   - Proxy detects token expiration
   - Automatically refreshes token
   - Retries request with new token

2. **Check token cache:**
```bash
# Tokens are cached for 30 minutes
# Force refresh by restarting server
```

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
export DEBUG_HTTP_REQUESTS=true
mcp-abap-adt-proxy
```

### Check Routing Decisions

Look for logs like:
```
[DEBUG] Routing decision made: { strategy: "proxy-cloud-llm-hub", destination: "sk" }
```

### Monitor Circuit Breaker

Look for logs like:
```
[WARN] Circuit breaker opened due to failures: { failures: 5, threshold: 5 }
[INFO] Circuit breaker closed after successful request
```

### Check Connection Cache

Look for logs like:
```
[DEBUG] Creating new direct cloud connection
[DEBUG] Reusing cached direct cloud connection
```

### Verify Token Retrieval

Look for logs like:
```
[DEBUG] Retrieved JWT token from auth-broker
[DEBUG] Using cached JWT token
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
[DEBUG] Routing decision made: { strategy: "proxy-cloud-llm-hub" }
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

1. **Always set CLOUD_LLM_HUB_URL** - Even if not using proxy, set it to avoid warnings
2. **Monitor circuit breaker** - Check logs for circuit breaker state
3. **Use appropriate timeouts** - Set timeouts based on network conditions
4. **Keep service keys secure** - Never commit service keys to version control
5. **Enable debug logging** - Use debug mode for troubleshooting
6. **Check network connectivity** - Verify connectivity before troubleshooting
7. **Validate configuration** - Always validate config on startup


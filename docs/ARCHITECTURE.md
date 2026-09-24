# Architecture Documentation

This document describes the architecture of `@mcp-abap-adt/proxy`.

## Overview

The MCP ABAP ADT Proxy is a simple middleware server that sits between MCP clients (like Cline) and any MCP server. It adds JWT authentication tokens to requests and forwards them to the target MCP server.

## System Architecture

```
┌─────────────────┐
│  MCP Client     │
│  (Cline, etc.)  │
└────────┬─────────┘
         │
         │ HTTP/SSE/Stdio
         │ (with x-sap-destination header)
         │
┌────────▼─────────────────────────────────────┐
│     MCP ABAP ADT Proxy                       │
│                                               │
│  ┌──────────────────────────────────────┐   │
│  │   Request Interceptor                │   │
│  │   - Extract x-sap-destination        │   │
│  │   - Extract x-target-url            │   │
│  └──────────────┬───────────────────────┘   │
│                 │                             │
│  ┌──────────────▼───────────────────────┐   │
│  │   Proxy Client                        │   │
│  │   - Get JWT Token (AuthBroker)        │   │
│  │   - Add Authorization Header          │   │
│  │   - Forward to MCP server            │   │
│  │   - Error Handling                    │   │
│  └───────────────────────────────────────┘   │
└───────────────────────────────────────────────┘
         │
         │ HTTP Request
         │ (with JWT token)
         │
┌────────▼─────────────────────────────────────┐
│     Target MCP Server                        │
│     (URL from service key or x-target-url)   │
└───────────────────────────────────────────────┘
```

## Process Model

**Location:** `bin/mcp-abap-adt-proxy.js`

The CLI entry point handles `--help` and `--version`, then loads
`dist/index.js` **in the same process** with `require`. It does not spawn a
child, and must not start doing so again.

That constraint is the whole point. The launcher previously spawned the server
and forwarded only `SIGINT`, so `SIGTERM` — what `kill`, `pkill`, service
managers and MCP clients send — killed the launcher and left the server running,
re-parented to `init`/`systemd`, still holding its HTTP port and, if a login was
in progress, its OAuth callback port. Running in one process means every signal
reaches the server directly.

Shutdown is handled in `src/index.ts`: `SIGINT`, `SIGTERM` and `SIGHUP` all run
the same handler, which closes the MCP server and the HTTP listener and releases
the callback port. The handler is idempotent, so repeated or overlapping signals
shut down once.

`SIGHUP` is registered deliberately rather than left to Node's default, because
Node terminates on it only while nothing has registered a listener. That used to
matter for a second reason as well: `@mcp-abap-adt/auth-providers` registered its
own `SIGHUP` listener during a login, which suppressed the default terminate, so
without this handler a closing terminal did not stop the proxy at all — it kept
running and holding its ports until the authentication timeout.

That is no longer how the provider works. Since `auth-providers@1.2.0` the
callback socket has one owner and one release point, and the port is freed when
the login scope ends however it ends; `2.0.0` registers no process signal
handlers at all. The proxy's own handler is what shuts it down, and it is worth
keeping registered rather than relying on Node's default, which a future
dependency could suppress again just as silently.

Regression tests for this live in `src/__tests__/bin/signalHandling.test.ts` and
`src/__tests__/bin/callbackPortLifecycle.test.ts`. They drive the built binary,
so they need `npm run build` first, and they are POSIX-only.

## Component Architecture

### 1. Request Interceptor

**Location:** `src/router/requestInterceptor.ts`

**Responsibilities:**
- Intercept incoming HTTP requests
- Extract headers and body
- Analyze request for routing decisions
- Sanitize headers for logging

**Key Functions:**
- `interceptRequest()` - Main interception function
- `sanitizeHeadersForLogging()` - Remove sensitive data from headers for safe logging

### 2. Header Analyzer

**Location:** `src/router/headerAnalyzer.ts`

**Responsibilities:**
- Extract `x-sap-destination` header (for BTP authentication)
- Extract `x-target-url` header (optional target URL override)
- Determine routing decision

**Key Functions:**
- `analyzeHeaders()` - Main analysis function, extracts routing info and returns `RoutingDecision`
- `shouldProxy()` - Check if request should be proxied

**Routing Strategy:**
- `PROXY` - Proxy request with JWT authentication (when `x-sap-destination` / `--btp` is present)
- `UNKNOWN` - No BTP destination provided; request cannot be routed (rejected with `400`)

### 3. Proxy Client

**Location:** `src/proxy/credentials.ts`, `src/proxy/btpProxy.ts`, `src/proxy/reverseProxy.ts`

**Responsibilities:**
- Turn a destination into the credential it authenticates with and the base URL its requests go to
- Forward the request transparently, with that credential's header on it
- Retry getting a token when the failure can get better, and explain it when it cannot

**Key Features:**
- The ecosystem's shared credential — `TokenAuthProvider` over `AuthBroker.createTokenRefresher()`
- One credential and one broker per destination; **no token cache and no refresh timer here**. The credential is asked for a header per request and renews behind that call
- Retry with exponential backoff while acquiring a token — scoped: 5xx and network failures are retried, a missing service key is not, so the common failure answers at once instead of three times more slowly
- **No circuit breaker.** It guarded the buffered forward that is gone; the streaming path has nowhere to put one without buffering the response again

**Flow:**
1. Receive request with `x-sap-destination` header (or `--btp`)
2. Ask the destination's credential for an `Authorization` header value
3. Take the base URL from the service key, unless `x-target-url` / `--target-url` overrides it
4. `forwardRequest()` streams the request to that URL with the header as given
5. Stream the response back untouched

**One path, not two.** An earlier version carried the SSE transport over axios,
buffering the response and rewrapping it as a JSON-RPC envelope. Every transport
now uses the same pipe. The SSE path reads the body first — its error envelopes
have to echo the JSON-RPC `id` — and hands those exact bytes to the pipe, since
a stream read once cannot be piped.

### 6. Error Handler

**Location:** `src/lib/errorHandler.ts`

**Responsibilities:**
- Retry logic with exponential backoff
- Deciding which failures are worth retrying

**Key Components:**
- `retryWithBackoff()` - Retry function; used around token acquisition
- `isRetryableError()` - Which failures can get better: 5xx, network errors, and an expired-or-invalid token
- `CircuitBreaker` - **still exported, no longer used by this package.** It guarded the buffered forward removed in 4.0.0

### 7. Configuration Manager

**Location:** `src/lib/config.ts`

**Responsibilities:**
- Load configuration from files and environment
- Validate configuration
- Merge configurations with precedence

**Configuration Sources (mutually exclusive):**
- With `--config`/`-c`: loaded **only** from the given YAML/JSON file
- Without `--config`: CLI params + environment variables + defaults

## Request Flow

### Proxy Request Flow

```
1. Client Request (with x-sap-destination header)
   ↓
2. Request Interceptor
   - Extract headers
   - Parse request body
   ↓
3. Header Analyzer
   - Extract x-sap-destination (for BTP auth)
   - Extract x-target-url (optional URL override)
   ↓
4. Proxy Client
   ↓
5. Ask the destination's credential for an Authorization header
   (retried on a failure that can get better)
   ↓
7. Build Proxy Request
   - Add JWT to Authorization header
   - Get MCP server URL from service key
   ↓
8. Forward to Target MCP Server (with retry)
   ↓
9. Handle Response/Errors
   ↓
10. Return Response to Client
```

## Token Management

### Token Caching

JWT tokens are cached by BTP destination name.

**Cache Key:**
```typescript
btpDestination // e.g., "btp-cloud", "ai"
```

**Cache TTL:**
- Tokens cached for 30 minutes
- Automatic refresh on expiration
- Force refresh on 401/403 errors

### Token Lifecycle

1. **Retrieval**: Get token from AuthBroker for BTP destination
2. **Caching**: Cache token with expiration time
3. **Usage**: Reuse cached token for subsequent requests
4. **Refresh**: Automatically refresh on expiration or error

## Error Handling & Resilience

### Retry Logic

- **Exponential Backoff**: Delay increases exponentially with each retry
- **Retryable Errors**: 500, 502, 503, 504 status codes
- **Network Errors**: Automatically retried
- **Token Errors**: Handled separately with token refresh

### ~~Circuit Breaker~~ — removed in 4.0.0

It only ever guarded the buffered axios forward. The forwarding path streams, and
a breaker there would mean buffering the response again. A target that keeps
failing now fails visibly each time instead of being short-circuited.

## Security Considerations

### Header Sanitization

Sensitive headers are sanitized in logs:
- `authorization`
- `x-sap-jwt-token`
- `x-sap-refresh-token`
- `x-sap-password`
- `x-sap-uaa-client-secret`

### Token Security

- Tokens never logged in plain text
- Tokens cached securely in memory
- Token refresh handled automatically

### Connection Isolation

- Each session has isolated connections
- No cross-session data leakage
- Session-based connection caching

## Performance Optimizations

### Token Caching

- JWT tokens cached for 30 minutes
- Reduces AuthBroker calls
- Automatic refresh on expiration
- Per-destination caching

### Request Reuse

- Axios instance reused for all requests
- Efficient HTTP connection pooling
- Automatic retry with exponential backoff

## Scalability

### Horizontal Scaling

- Stateless design (except token cache)
- Multiple instances can run in parallel
- Load balancer can distribute requests

### Vertical Scaling

- No token is cached here, so nothing goes stale and no refresh timer runs per destination
- The response is never buffered, so a large or long-lived one costs a socket rather than memory

## Monitoring & Observability

### Logging

- Structured logging with types
- Debug mode for detailed logs
- Error tracking with context

### Metrics (Future)

- Request count by strategy
- Circuit breaker state
- Token cache size
- Token refresh count
- Error rates

## Extension Points

### Custom Error Handlers

Error handling can be customized by:
1. Extending `errorHandler.ts`
2. Implementing custom retry logic
3. Adding custom circuit breaker behavior

### Custom Token Providers

Token management can be extended by:
1. Implementing custom AuthBroker integration
2. Adding custom token caching strategies
3. Supporting additional authentication methods

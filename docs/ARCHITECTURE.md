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
         │ (with x-btp-destination header)
         │
┌────────▼─────────────────────────────────────┐
│     MCP ABAP ADT Proxy                       │
│                                               │
│  ┌──────────────────────────────────────┐   │
│  │   Request Interceptor                │   │
│  │   - Extract x-btp-destination        │   │
│  │   - Extract x-mcp-url               │   │
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
│     (URL from service key or x-mcp-url)      │
└───────────────────────────────────────────────┘
```

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
- Extract `x-btp-destination` header (for BTP authentication)
- Extract `x-mcp-url` header (for direct MCP server URL)
- Determine routing decision

**Key Functions:**
- `analyzeHeaders()` - Main analysis function, extracts routing info and returns `RoutingDecision`
- `shouldProxy()` - Check if request should be proxied

**Routing Strategy:**
- `PROXY` - Proxy request with JWT authentication (when `x-btp-destination` or `x-mcp-url` is present)
- `PASSTHROUGH` - No proxy headers found, forward unchanged

### 3. Proxy Client

**Location:** `src/proxy/cloudLlmHubProxy.ts`

**Responsibilities:**
- Proxy requests to target MCP server
- Manage JWT tokens via AuthBroker (BTP/XSUAA ClientCredentials)
- Handle retries and error recovery
- Implement circuit breaker pattern

**Key Features:**
- JWT token caching and refresh
- Automatic retry with exponential backoff
- Circuit breaker for resilience
- Token expiration handling

**Flow:**
1. Receive MCP request with `x-btp-destination` header
2. Get JWT token from AuthBroker for destination (with caching)
3. Get MCP server URL from service key for destination
4. Build proxy request with JWT token in Authorization header
5. Forward to MCP server URL
6. Handle response or errors
7. Return MCP-formatted response

### 6. Error Handler

**Location:** `src/lib/errorHandler.ts`

**Responsibilities:**
- Comprehensive error handling
- Retry logic with exponential backoff
- Circuit breaker implementation
- Token expiration detection

**Key Components:**
- `CircuitBreaker` - Circuit breaker class
- `retryWithBackoff()` - Retry function
- `isTokenExpirationError()` - Token error detection
- `createErrorResponse()` - MCP error formatting

### 7. Configuration Manager

**Location:** `src/lib/config.ts`

**Responsibilities:**
- Load configuration from files and environment
- Validate configuration
- Merge configurations with precedence

**Configuration Sources:**
1. Environment variables (highest priority)
2. Configuration file (`mcp-proxy-config.json`)
3. Default values (lowest priority)

## Request Flow

### Proxy Request Flow

```
1. Client Request (with x-btp-destination header)
   ↓
2. Request Interceptor
   - Extract headers
   - Parse request body
   ↓
3. Header Analyzer
   - Extract x-btp-destination (for BTP auth)
   - Extract x-mcp-url (for direct URL)
   ↓
4. Proxy Client
   ↓
5. Check Circuit Breaker
   ↓
6. Get JWT Token (from cache or AuthBroker)
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

### Circuit Breaker

**States:**
- **Closed**: Normal operation, requests allowed
- **Open**: Too many failures, requests rejected
- **Half-Open**: Testing if service recovered

**Transitions:**
- Closed → Open: After threshold failures
- Open → Half-Open: After timeout period
- Half-Open → Closed: After successful request
- Half-Open → Open: After failure

### Token Management

- **Caching**: Tokens cached for 30 minutes
- **Refresh**: Automatic refresh on expiration
- **Retry**: Retry with fresh token on 401/403 errors

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

- Token caching reduces memory usage
- Efficient error handling reduces CPU usage
- Circuit breaker prevents resource exhaustion

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

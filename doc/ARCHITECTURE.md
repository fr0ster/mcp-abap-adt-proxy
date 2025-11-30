# Architecture Documentation

This document describes the architecture of `@mcp-abap-adt/proxy`.

## Overview

The MCP ABAP ADT Proxy is a middleware server that sits between MCP clients (like Cline) and cloud ABAP systems. It provides intelligent routing based on authentication headers and handles JWT token management automatically.

## System Architecture

```
┌─────────────────┐
│  MCP Client     │
│  (Cline, etc.)  │
└────────┬─────────┘
         │
         │ HTTP/SSE/Stdio
         │
┌────────▼─────────────────────────────────────┐
│     MCP ABAP ADT Proxy                       │
│                                               │
│  ┌──────────────────────────────────────┐   │
│  │   Request Interceptor                │   │
│  │   - Header Analysis                  │   │
│  │   - Routing Decision                 │   │
│  └──────────────┬───────────────────────┘   │
│                 │                             │
│  ┌──────────────▼───────────────────────┐   │
│  │   Router                              │   │
│  │                                       │   │
│  │  ┌────────────┐  ┌──────────────┐   │   │
│  │  │  Direct    │  │  Local Basic │   │   │
│  │  │  Cloud     │  │  Router      │   │   │
│  │  └────────────┘  └──────────────┘   │   │
│  │                                       │   │
│  │  ┌──────────────────────────────┐   │   │
│  │  │  Cloud LLM Hub Proxy          │   │   │
│  │  │  - JWT Token Management       │   │   │
│  │  │  - Request Forwarding         │   │   │
│  │  │  - Error Handling             │   │   │
│  │  └──────────────────────────────┘   │   │
│  └───────────────────────────────────────┘   │
└───────────────────────────────────────────────┘
         │                    │              │
         │                    │              │
    ┌────▼────┐        ┌──────▼──────┐  ┌───▼──────┐
    │  Cloud  │        │  Cloud      │  │  On-Prem │
    │  ABAP   │        │  LLM Hub    │  │  ABAP    │
    │ (Direct)│        │             │  │ (Basic)  │
    └─────────┘        └─────────────┘  └──────────┘
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
- `requiresSapConfig()` - Check if request needs SAP config
- `sanitizeHeadersForLogging()` - Remove sensitive data

### 2. Header Analyzer

**Location:** `src/router/headerAnalyzer.ts`

**Responsibilities:**
- Analyze HTTP headers to determine routing strategy
- Validate authentication headers
- Determine routing decision

**Key Functions:**
- `analyzeHeaders()` - Main analysis function
- `isDirectCloudRequest()` - Check for direct cloud routing
- `isLocalBasicAuth()` - Check for local basic auth
- `shouldProxyToCloudLlmHub()` - Check for proxy routing

**Routing Strategies:**
- `DIRECT_CLOUD` - Route directly to cloud ABAP
- `LOCAL_BASIC` - Handle locally with basic auth
- `PROXY_CLOUD_LLM_HUB` - Proxy to cloud-llm-hub
- `UNKNOWN` - Unknown/unsupported

### 3. Direct Cloud Router

**Location:** `src/router/directCloudRouter.ts`

**Responsibilities:**
- Create and manage ABAP connections for direct cloud routing
- Handle destination-based authentication
- Cache connections for performance

**Key Functions:**
- `createDirectCloudConfig()` - Create config from routing decision
- `getDirectCloudConnection()` - Get or create connection

**Connection Management:**
- Connection caching by session ID and config signature
- Automatic cleanup of old connections
- Integration with AuthBroker for JWT tokens

### 4. Local Basic Router

**Location:** `src/router/localBasicRouter.ts`

**Responsibilities:**
- Create and manage ABAP connections for basic auth
- Handle local authentication
- Cache connections for performance

**Key Functions:**
- `createLocalBasicConfig()` - Create config from routing decision
- `getLocalBasicConnection()` - Get or create connection

### 5. Cloud LLM Hub Proxy

**Location:** `src/proxy/cloudLlmHubProxy.ts`

**Responsibilities:**
- Proxy requests to cloud-llm-hub
- Manage JWT tokens via AuthBroker
- Handle retries and error recovery
- Implement circuit breaker pattern

**Key Features:**
- JWT token caching and refresh
- Automatic retry with exponential backoff
- Circuit breaker for resilience
- Token expiration handling

**Flow:**
1. Receive MCP request
2. Get JWT token from AuthBroker (with caching)
3. Build proxy request with JWT and original headers
4. Forward to cloud-llm-hub
5. Handle response or errors
6. Return MCP-formatted response

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

### Direct Cloud Request Flow

```
1. Client Request
   ↓
2. Request Interceptor
   ↓
3. Header Analyzer → DIRECT_CLOUD strategy
   ↓
4. Direct Cloud Router
   ↓
5. Get/Create ABAP Connection
   ↓
6. Process Request via Connection
   ↓
7. Return Response
```

### Local Basic Auth Flow

```
1. Client Request
   ↓
2. Request Interceptor
   ↓
3. Header Analyzer → LOCAL_BASIC strategy
   ↓
4. Local Basic Router
   ↓
5. Get/Create ABAP Connection (Basic Auth)
   ↓
6. Process Request via Connection
   ↓
7. Return Response
```

### Cloud LLM Hub Proxy Flow

```
1. Client Request
   ↓
2. Request Interceptor
   ↓
3. Header Analyzer → PROXY_CLOUD_LLM_HUB strategy
   ↓
4. Cloud LLM Hub Proxy
   ↓
5. Check Circuit Breaker
   ↓
6. Get JWT Token (from cache or AuthBroker)
   ↓
7. Build Proxy Request
   ↓
8. Forward to cloud-llm-hub (with retry)
   ↓
9. Handle Response/Errors
   ↓
10. Return Response
```

## Connection Management

### Connection Caching

Connections are cached by:
- Session ID
- Configuration signature (hash of config)

**Cache Key Generation:**
```typescript
hash(sessionId + sapUrl + destination + authType + client)
```

**Cache Cleanup:**
- Automatic cleanup of connections older than 1 hour
- Cleanup triggered when cache size exceeds 100 entries

### Connection Lifecycle

1. **Creation**: New connection created when cache miss
2. **Usage**: Connection reused for same session/config
3. **Cleanup**: Old connections removed automatically
4. **Disposal**: Connections disposed when no longer needed

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

### Connection Pooling

- Connections cached and reused
- Reduces connection overhead
- Automatic cleanup prevents memory leaks

### Token Caching

- JWT tokens cached for 30 minutes
- Reduces AuthBroker calls
- Automatic refresh on expiration

### Request Batching

- Multiple requests can share connection
- Session-based connection reuse
- Efficient resource utilization

## Scalability

### Horizontal Scaling

- Stateless design (except connection cache)
- Multiple instances can run in parallel
- Load balancer can distribute requests

### Vertical Scaling

- Connection caching reduces memory usage
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
- Connection cache size
- Token refresh count
- Error rates

## Extension Points

### Custom Routers

New routing strategies can be added by:
1. Adding strategy to `RoutingStrategy` enum
2. Implementing router module
3. Integrating in main server

### Custom Error Handlers

Error handling can be customized by:
1. Extending `errorHandler.ts`
2. Implementing custom retry logic
3. Adding custom circuit breaker behavior


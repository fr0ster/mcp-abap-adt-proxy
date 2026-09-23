# API Documentation

This document describes the API and interfaces provided by `@mcp-abap-adt/proxy`.

## Server Class

### `McpAbapAdtProxyServer`

Main server class for the MCP ABAP ADT Proxy.

#### Constructor

```typescript
constructor(transportConfig?: TransportConfig, configPath?: string)
```

**Parameters:**
- `transportConfig` (optional): Transport configuration. If not provided, parsed from command line arguments and environment variables.
- `configPath` (optional): Path to configuration file. If not provided, searches default locations.

**Example:**
```typescript
import { McpAbapAdtProxyServer } from "@mcp-abap-adt/proxy";

const server = new McpAbapAdtProxyServer();
await server.run();
```

#### Methods

##### `run(): Promise<void>`

Starts the proxy server and connects it to the transport.

**Returns:** Promise that resolves when server is started.

**Example:**
```typescript
await server.run();
```

##### `shutdown(): Promise<void>`

Gracefully shuts down the server and closes all connections.

**Returns:** Promise that resolves when server is shut down.

**Example:**
```typescript
await server.shutdown();
```

## Router Modules

### Header Analyzer

#### `analyzeHeaders(headers: IncomingHttpHeaders, configOverrides?: { btpDestination?: string; targetUrl?: string }): RoutingDecision`

Analyzes HTTP headers to determine routing strategy. CLI overrides (`--btp`, `--target-url`) take precedence over headers.

**Parameters:**
- `headers`: HTTP request headers
- `configOverrides`: optional `btpDestination` / `targetUrl` from CLI params

**Returns:** `RoutingDecision` object with routing strategy and metadata.

**Example:**
```typescript
import { analyzeHeaders } from "@mcp-abap-adt/proxy/router/headerAnalyzer";

const decision = analyzeHeaders(req.headers, { btpDestination: "ai" });
console.log(decision.strategy); // "proxy" | "unknown"
console.log(decision.btpDestination); // Destination for BTP Cloud authorization (from header or override)
console.log(decision.targetUrl); // Explicit target URL (from x-target-url or override)
```

#### Routing Strategies

- `PROXY`: Proxy request with JWT authentication (`x-sap-destination` / `--btp` present)
- `UNKNOWN`: No BTP destination provided — request cannot be routed

### Request Interceptor

#### `interceptRequest(req: IncomingMessage, body?: any): InterceptedRequest`

Intercepts and analyzes incoming HTTP request.

**Parameters:**
- `req`: HTTP request object
- `body`: Optional request body

**Returns:** `InterceptedRequest` object with routing decision and metadata.

**Example:**
```typescript
import { interceptRequest } from "@mcp-abap-adt/proxy/router/requestInterceptor";

const intercepted = interceptRequest(req, body);
console.log(intercepted.routingDecision.strategy);
```

## Proxy Modules

### BTP Proxy

#### `BtpProxy`

A facade over the destination's credential. It does not carry requests — that is
`forwardRequest()` below.

##### `getAuthorizationHeader(destination): Promise<string | null>`

The `Authorization` header VALUE for a destination — `Bearer <token>`, complete —
or `null` where the credential is not a header at all.

Asked on every request, deliberately. The credential renews behind this call, so
a cache on the caller's side would serve the stale token and hide the renewal.

##### `getTargetUrl(destination): Promise<string>`

Where that destination's requests go: `targetUrl` from the config if set,
otherwise `serviceUrl` from the service key. Throws when neither exists.

##### `dispose(): void`

Lets go of the credentials and brokers held. There are no timers to cancel.

**Example:**
```typescript
import { createBtpProxy } from "@mcp-abap-adt/proxy/proxy/btpProxy";

const proxy = await createBtpProxy(config);
const authorization = await proxy.getAuthorizationHeader("my-destination");
const targetUrl = await proxy.getTargetUrl("my-destination");
```

### Reverse Proxy

#### `forwardRequest(clientReq, clientRes, targetBaseUrl, authorization, defaultHeaders?, requestBody?)`

The single transparent pipe. Every transport goes through it.

**Parameters:**
- `clientReq` / `clientRes`: the incoming request and its response
- `targetBaseUrl`: where to forward
- `authorization`: a complete header VALUE, or `null` for no header at all. It is
  NOT a token — composing `Bearer` around it would send `Bearer Bearer <token>`
- `defaultHeaders`: injected first; client headers win
- `requestBody`: for a caller that has already read the request. The SSE path
  parses the JSON-RPC body because its error envelopes echo the `id`, and a
  stream read once cannot be piped. Pass the bytes as they arrived, not a
  re-serialised parse — the client's `content-length` is forwarded unchanged

The response streams; nothing is buffered on the way back.


## Error Handling

### `CircuitBreaker`

Circuit breaker implementation for resilience.

#### Methods

- `canProceed(): boolean` - Check if circuit breaker allows request
- `recordSuccess(): void` - Record successful request
- `recordFailure(): void` - Record failed request
- `getState(): "closed" | "open" | "half-open"` - Get current state
- `reset(): void` - Reset circuit breaker

**Example:**
```typescript
import { CircuitBreaker } from "@mcp-abap-adt/proxy/lib/errorHandler";

const breaker = new CircuitBreaker(5, 60000); // threshold: 5, timeout: 60s

if (breaker.canProceed()) {
  try {
    await makeRequest();
    breaker.recordSuccess();
  } catch (error) {
    breaker.recordFailure();
  }
}
```

### `retryWithBackoff<T>(fn, options): Promise<T>`

Retry function with exponential backoff.

**Parameters:**
- `fn`: Function to retry
- `options`: Retry options (maxRetries, retryDelay, etc.)

**Returns:** Promise resolving to function result.

**Example:**
```typescript
import { retryWithBackoff } from "@mcp-abap-adt/proxy/lib/errorHandler";

const result = await retryWithBackoff(
  () => makeRequest(),
  { maxRetries: 3, retryDelay: 1000 }
);
```

## Configuration

### `loadConfig(configPath?): ProxyConfig`

Loads configuration from file and environment variables.

**Parameters:**
- `configPath`: Optional path to configuration file

**Returns:** Proxy configuration object.

**Example:**
```typescript
import { loadConfig } from "@mcp-abap-adt/proxy/lib/config";

const config = loadConfig("/path/to/config.json");
```

### `validateConfig(config): { valid, errors, warnings }`

Validates configuration.

**Parameters:**
- `config`: Configuration object to validate

**Returns:** Validation result with errors and warnings.

**Example:**
```typescript
import { validateConfig } from "@mcp-abap-adt/proxy/lib/config";

const validation = validateConfig(config);
if (!validation.valid) {
  console.error("Configuration errors:", validation.errors);
}
```

## Types

### `ProxyConfig`

```typescript
interface ProxyConfig {
  httpPort: number;
  ssePort: number;
  httpHost: string;
  sseHost: string;
  logLevel: string;
  btpDestination?: string;
  targetUrl?: string;
  defaultHeaders?: Record<string, string>;
  unsafe?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  requestTimeout?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerTimeout?: number;
  browser?: 'system' | 'headless' | 'chrome' | 'edge' | 'firefox' | 'none';
  browserAuthPort?: number;
}
```

### `RoutingDecision`

```typescript
interface RoutingDecision {
  strategy: RoutingStrategy;     // RoutingStrategy.PROXY | RoutingStrategy.UNKNOWN
  btpDestination?: string;       // Destination for BTP Cloud authorization (x-sap-destination or --btp)
  targetUrl?: string;            // Explicit target URL (x-target-url or --target-url)
  reason: string;
}
```

### `ProxyRequest`

```typescript
interface ProxyRequest {
  method: string;
  params?: any;
  id?: string | number | null;
  jsonrpc?: string;
}
```

### `ProxyResponse`

```typescript
interface ProxyResponse {
  jsonrpc: string;
  id?: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}
```


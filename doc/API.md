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

#### `analyzeHeaders(headers: IncomingHttpHeaders): RoutingDecision`

Analyzes HTTP headers to determine routing strategy.

**Parameters:**
- `headers`: HTTP request headers

**Returns:** `RoutingDecision` object with routing strategy and metadata.

**Example:**
```typescript
import { analyzeHeaders } from "@mcp-abap-adt/proxy/router/headerAnalyzer";

const decision = analyzeHeaders(req.headers);
console.log(decision.strategy); // "direct-cloud" | "local-basic" | "proxy-cloud-llm-hub" | "unknown"
```

#### Routing Strategies

- `DIRECT_CLOUD`: Route directly to cloud ABAP (x-sap-destination: "S4HANA_E19")
- `LOCAL_BASIC`: Handle locally with basic auth (x-sap-auth-type: "basic")
- `PROXY_CLOUD_LLM_HUB`: Proxy to cloud-llm-hub with JWT (x-sap-destination: "sk")
- `UNKNOWN`: Unknown/unsupported routing

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

### Cloud LLM Hub Proxy

#### `CloudLlmHubProxy`

Proxy client for forwarding requests to cloud-llm-hub.

##### `proxyRequest(originalRequest, routingDecision, originalHeaders): Promise<ProxyResponse>`

Proxies MCP request to cloud-llm-hub with JWT authentication.

**Parameters:**
- `originalRequest`: MCP request object
- `routingDecision`: Routing decision from header analysis
- `originalHeaders`: Original HTTP headers

**Returns:** Promise resolving to MCP response.

**Example:**
```typescript
import { createCloudLlmHubProxy } from "@mcp-abap-adt/proxy/proxy/cloudLlmHubProxy";

const proxy = await createCloudLlmHubProxy("https://cloud-llm-hub.example.com");
const response = await proxy.proxyRequest(request, decision, headers);
```

### Direct Cloud Router

#### `getDirectCloudConnection(sessionId, config, authBroker?): Promise<AbapConnection>`

Gets or creates ABAP connection for direct cloud routing.

**Parameters:**
- `sessionId`: Session identifier
- `config`: Direct cloud configuration
- `authBroker`: Optional AuthBroker instance

**Returns:** Promise resolving to ABAP connection.

**Example:**
```typescript
import { getDirectCloudConnection, createDirectCloudConfig } from "@mcp-abap-adt/proxy/router/directCloudRouter";

const config = createDirectCloudConfig(routingDecision, headers);
const connection = await getDirectCloudConnection(sessionId, config, authBroker);
```

### Local Basic Router

#### `getLocalBasicConnection(sessionId, config): Promise<AbapConnection>`

Gets or creates ABAP connection for local basic auth.

**Parameters:**
- `sessionId`: Session identifier
- `config`: Local basic configuration

**Returns:** Promise resolving to ABAP connection.

**Example:**
```typescript
import { getLocalBasicConnection, createLocalBasicConfig } from "@mcp-abap-adt/proxy/router/localBasicRouter";

const config = createLocalBasicConfig(routingDecision, headers);
const connection = await getLocalBasicConnection(sessionId, config);
```

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
  cloudLlmHubUrl: string;
  httpPort: number;
  ssePort: number;
  httpHost: string;
  sseHost: string;
  logLevel: string;
  maxRetries?: number;
  retryDelay?: number;
  requestTimeout?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerTimeout?: number;
}
```

### `RoutingDecision`

```typescript
interface RoutingDecision {
  strategy: RoutingStrategy;
  destination?: string;
  authType?: string;
  reason: string;
  validationResult?: HeaderValidationResult;
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


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

### ~~`CircuitBreaker`~~ — removed in 4.0.0

It guarded the buffered axios forward this release deletes. The forwarding path
now streams, and a breaker there would mean buffering the response again — the
thing being fixed. `circuitBreakerThreshold` and `circuitBreakerTimeout` are
still accepted in configuration so existing files load unchanged, and have no
effect.

### ~~`ProxyRequest`~~ / ~~`ProxyResponse`~~ — removed in 4.0.0

These described the JSON-RPC envelope the deleted axios path rebuilt by hand and
answered with. Every transport now forwards through `forwardRequest()`, which
carries the request and the response as they are, so there is no envelope for
this package to name.

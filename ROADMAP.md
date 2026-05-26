# Development Roadmap: mcp-abap-adt-proxy

## Project Overview

**Package Name**: `@mcp-abap-adt/proxy`
**Purpose**: Authorization proxy that lets local MCP clients (Cline, Claude Code) reach MCP servers and other services deployed on SAP BTP, by obtaining a JWT and forwarding authenticated requests.
**Target**: A thin proxy layer in front of any BTP-deployed service.

## Core Functionality

The proxy intercepts MCP requests, injects a BTP/XSUAA authorization token, and forwards them to the target service:

1. **Proxy Requests** (require a BTP destination)
   - Gets a BTP Cloud authorization token from `x-sap-destination` (or `--btp` parameter)
   - Resolves the target URL from the destination's service key (`abap.url`)
   - Optionally overrides the target URL via `x-target-url` (or `--target-url`)
   - Adds `Authorization: Bearer <token>`
   - Forwards the request transparently (reverse proxy) to the target
   - Optionally injects default headers (`--header` / `defaultHeaders`); client headers win

## Development Phases

### Phase 1: Project Setup & Foundation ✅

- [x] Create GitHub repository
- [x] Initialize npm package with TypeScript
- [x] Set up package.json with dependencies:
  - `@modelcontextprotocol/sdk` - MCP SDK
  - `@mcp-abap-adt/auth-broker` - JWT token management
  - `@mcp-abap-adt/header-validator` - Header validation
- [x] Configure TypeScript
- [x] Set up build scripts
- [x] Create basic project structure

### Phase 2: Request Interception & Analysis ✅

- [x] Implement MCP server setup (similar to mcp-abap-adt)
- [x] Create request interceptor middleware
- [x] Implement header analysis logic:
  - Extract `x-sap-destination` header (required, for BTP Cloud authorization)
  - Extract `x-target-url` header (optional, target URL override)
  - Route decision logic (`PROXY` / `UNKNOWN` strategy)
- [x] Add request logging/debugging
- [x] Support command-line overrides (`--btp` and `--target-url` parameters)

### Phase 3-4: Simplified Architecture ✅

- [x] Removed direct cloud routing (simplified to proxy-only)
- [x] Removed basic auth handling (simplified to proxy-only)
- [x] Removed direct unauthenticated `x-mcp-url` routing (consolidated into the BTP path)
- [x] Focus on single responsibility: add authentication and forward requests

### Phase 5: BTP Proxy with JWT ✅

- [x] Implement proxy routing keyed on `x-sap-destination` / `--btp`
- [x] Integrate with `@mcp-abap-adt/auth-broker`:
  - Get a JWT token for the BTP destination
  - Handle token refresh
  - Cache tokens per destination
- [x] Build proxy request:
  - Target URL from the service key (`abap.url`) or `x-target-url` override
  - Add `Authorization: Bearer <token>`
  - Preserve original request context
- [x] Forward request transparently to the target (reverse proxy)
- [x] Handle proxy responses (forward format, handle errors, preserve MCP structure)
- [x] Require a BTP destination (`x-sap-destination` or `--btp`); otherwise `400`

### Phase 6: Configuration & Environment ✅

- [x] Support a YAML/JSON config file via `--config` / `-c`
- [x] Support environment variables and CLI parameters
- [x] Add default-headers injection (`--header` / `defaultHeaders`)
- [x] Document configuration options

### Phase 7: Error Handling & Resilience ✅

- [x] Implement comprehensive error handling
- [x] Add retry logic for failed requests
- [x] Handle token expiration gracefully
- [x] Add circuit breaker
- [x] Implement request timeout handling

### Phase 8: Testing ✅

- [x] Unit tests for routing logic (`headerAnalyzer.test.ts`)
- [x] Unit tests for header analysis (extraction, validation, command-line overrides)
- [x] Unit tests for request interceptor (`requestInterceptor.test.ts`)
- [x] Unit tests for proxy client (`cloudLlmHubProxy.test.ts`)
- [x] Test error scenarios (missing destination, token errors, network errors)
- [x] Test command-line parameter overrides
- [ ] Integration tests with auth-broker
- [ ] End-to-end tests with MCP client

### Phase 9: Documentation ✅

- [x] API documentation
- [x] Configuration guide
- [x] Usage examples
- [x] Architecture documentation
- [x] Troubleshooting guide

### Phase 10: Performance & Optimization

- [ ] Implement request caching where appropriate
- [ ] Optimize token caching
- [ ] Add connection pooling
- [ ] Performance testing
- [ ] Load testing

### Phase 11: Deployment & Publishing ✅

- [x] Prepare for npm publishing
- [x] Create release process
- [x] Publish to npm as `@mcp-abap-adt/proxy`
- [ ] Set up CI/CD pipeline

## Technical Architecture

### Request Flow

```
MCP Client (Cline)
    ↓
mcp-abap-adt-proxy
    ↓
[Header Analysis]
    - Extract x-sap-destination (or use --btp parameter) — required
    - Extract x-target-url (optional) or use --target-url parameter
    ↓
[Route Decision]
    - No BTP destination → UNKNOWN → 400
    - Otherwise → PROXY
    ↓
[Get Token from auth-broker]
    - Get BTP Cloud token (from x-sap-destination or --btp)
    ↓
[Build Proxy Request]
    - Add Authorization: Bearer <btp-token>
    - Inject default headers (client headers take precedence)
    - Target URL from service key (abap.url) or x-target-url override
    ↓
Target MCP Server / BTP service
    ↓
Response back to Cline
```

### Key Components

1. **Header Analyzer** (`src/router/headerAnalyzer.ts`)
   - Analyzes headers, decides routing strategy (`PROXY` / `UNKNOWN`)

2. **BTP Proxy** (`src/proxy/btpProxy.ts`)
   - Integrates with auth-broker; manages token lifecycle and refresh

3. **Reverse Proxy** (`src/proxy/reverseProxy.ts`)
   - Transparent request/response forwarding with the injected token

4. **MCP Server** (`src/index.ts`)
   - stdio / HTTP / streamable-http / SSE transports

## Dependencies

### Core Dependencies
- `@modelcontextprotocol/sdk` - MCP protocol
- `@mcp-abap-adt/auth-broker` - JWT authentication
- `@mcp-abap-adt/header-validator` - Header validation

### Development Dependencies
- `typescript` - TypeScript compiler
- `jest` - Testing framework
- `@types/node` - Node.js types

## Configuration

### Environment Variables
- `MCP_HTTP_PORT` - Port for HTTP server (default: 3001)
- `MCP_SSE_PORT` - Port for SSE server (default: 3002)
- `MCP_HTTP_HOST` / `MCP_SSE_HOST` - Host bindings (default: 127.0.0.1, loopback)
- `MCP_TRANSPORT` - Transport type (stdio | http | streamable-http | sse)
- `MCP_PROXY_UNSAFE` - Persist tokens to disk when `"true"`
- `LOG_LEVEL` - Logging level

### Command Line Parameters
- `--btp=<destination>` - BTP destination for authorization (or header `x-sap-destination`)
- `--target-url=<url>` - Override the target URL (or header `x-target-url`)
- `--header key=value` - Default header injected into every request (repeatable)
- `--browser=<type>` / `--browser-auth-port=<port>` - OAuth2 login browser settings
- `--unsafe` - Persist tokens to disk
- `--config=<file>` / `-c` - Load configuration from a YAML/JSON file

### Configuration File
See [YAML Configuration Guide](./docs/YAML_CONFIG.md). Loaded only via `--config`.

```yaml
transport: streamable-http
httpPort: 3001
btpDestination: "btp-cloud"
logLevel: "info"
```

### Headers in Request
- `x-sap-destination` - BTP Cloud authorization destination (required, or use `--btp`)
- `x-target-url` - Override the target URL (optional, or use `--target-url`)
- All other headers are passed directly to the target without validation

## Success Criteria

- [x] Successfully proxies requests from Cline to the target via a BTP destination
- [x] Automatically manages JWT tokens via auth-broker
- [x] Requires only the BTP destination; passes all other headers through
- [x] Supports command-line parameter overrides (`--btp`, `--target-url`)
- [x] Uses only destinations (service key files) for connection configuration, no .env files
- [x] Maintains MCP protocol compliance
- [x] Provides clear error messages
- [x] Well-documented (README, USAGE, API docs)
- [x] Unit tests implemented

## Current Issues & Future Work

### Routing Logic Refinement ✅

**Status**: ✅ Completed

The routing logic has been simplified and clarified. See [Routing Logic Specification](./docs/ROUTING_LOGIC.md) for detailed documentation.

**Current Behavior:**
- Proxy requires a BTP destination: `x-sap-destination` (or `--btp`)
- `x-target-url` (or `--target-url`) optionally overrides the target URL; auth still comes from the BTP destination
- All other headers are passed directly to the target without validation or modification
- Connection configuration comes only from destinations (service key files) via auth-broker
- No `.env` files are used for connection configuration (session stores may use `.env` for token storage, but that's separate)

See [Routing Logic Specification](./docs/ROUTING_LOGIC.md) for complete details.

## Notes

- This proxy should be transparent to MCP clients
- JWT token management should be automatic and seamless
- Error handling should provide clear feedback
- Performance should be comparable to direct connections
- **No .env file usage**: Proxy should only use destinations via auth-broker, never `.env` files

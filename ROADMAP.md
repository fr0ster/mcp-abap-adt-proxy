# Development Roadmap: mcp-abap-adt-proxy

## Project Overview

**Package Name**: `@mcp-abap-adt/proxy`  
**Purpose**: MCP proxy server that routes local requests to cloud-llm-hub with JWT authentication  
**Target**: Similar architecture to `mcp-abap-adt` but acts as a proxy layer

## Core Functionality

The proxy intercepts MCP requests and adds authentication headers before forwarding to the target MCP server:

1. **Proxy Requests** (requires `x-mcp-url` header)
   - Extracts target MCP server URL from `x-mcp-url` header
   - Gets BTP Cloud authorization token from `x-btp-destination` (or `--btp` parameter)
   - Optionally gets SAP ABAP configuration from `x-mcp-destination` (or `--mcp` parameter)
   - Adds `Authorization: Bearer <token>` header for BTP Cloud
   - Adds SAP headers (`x-sap-jwt-token`, `x-sap-url`, etc.) if `x-mcp-destination` is provided
   - Forwards request to target MCP server specified in `x-mcp-url`

## Development Phases

### Phase 1: Project Setup & Foundation ✅

- [x] Create GitHub repository
- [x] Initialize npm package with TypeScript
- [x] Set up package.json with dependencies:
  - `@modelcontextprotocol/sdk` - MCP SDK
  - `@mcp-abap-adt/auth-broker` - JWT token management
  - `@mcp-abap-adt/header-validator` - Header validation
  - `axios` - HTTP client for proxying
- [x] Configure TypeScript
- [x] Set up build scripts
- [x] Create basic project structure

### Phase 2: Request Interception & Analysis ✅

- [x] Implement MCP server setup (similar to mcp-abap-adt)
- [x] Create request interceptor middleware
- [x] Implement header analysis logic:
  - Extract `x-mcp-url` header (required)
  - Extract `x-btp-destination` header (required, for BTP Cloud authorization)
  - Extract `x-mcp-destination` header (optional, for SAP ABAP connection)
  - Route decision logic (PROXY strategy)
- [x] Add request logging/debugging
- [x] Support command-line overrides (`--btp` and `--mcp` parameters)

### Phase 3-4: Simplified Architecture ✅

- [x] Removed direct cloud routing (simplified to proxy-only)
- [x] Removed basic auth handling (simplified to proxy-only)
- [x] Focus on single responsibility: add authentication and forward requests

### Phase 5: Cloud Proxy with JWT ✅

- [x] Implement proxy routing with `x-mcp-url` header
- [x] Integrate with `@mcp-abap-adt/auth-broker`:
  - Get JWT token for BTP Cloud (`x-btp-destination` or `--btp`)
  - Get JWT token for SAP ABAP (`x-mcp-destination` or `--mcp`, optional)
  - Handle token refresh
  - Cache tokens separately for each destination
- [x] Build proxy request:
  - Use full URL from `x-mcp-url` header
  - Add `Authorization: Bearer <token>` from BTP destination
  - Add SAP headers (`x-sap-jwt-token`, `x-sap-url`, etc.) from MCP destination (if provided)
  - Preserve original request context
- [x] Forward request to target MCP server
- [x] Handle proxy responses:
  - Forward response format
  - Handle errors
  - Preserve MCP protocol structure
- [x] Validate required headers (`x-mcp-url` and `x-btp-destination` or `--btp`)

### Phase 6: Configuration & Environment ✅

- [x] Add configuration for cloud-llm-hub URL
- [x] Support environment variables
- [x] Add configuration file support
- [x] Document configuration options

### Phase 7: Error Handling & Resilience ✅

- [x] Implement comprehensive error handling
- [x] Add retry logic for failed requests
- [x] Handle token expiration gracefully
- [x] Add circuit breaker for cloud-llm-hub
- [x] Implement request timeout handling

### Phase 8: Testing ✅

- [x] Unit tests for routing logic (`headerAnalyzer.test.ts` - 16 tests)
- [x] Unit tests for header analysis (extraction, validation, command-line overrides)
- [x] Unit tests for request interceptor (`requestInterceptor.test.ts` - 20 tests)
- [x] Unit tests for proxy client (`cloudLlmHubProxy.test.ts` - 11 tests)
- [x] Test error scenarios (missing headers, token errors, network errors)
- [x] Test command-line parameter overrides
- [ ] Integration tests with auth-broker
- [ ] Integration tests with cloud-llm-hub
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

### Phase 11: Deployment & Publishing

- [ ] Prepare for npm publishing
- [ ] Set up CI/CD pipeline
- [ ] Create release process
- [ ] Publish to npm as `@mcp-abap-adt/proxy`

## Technical Architecture

### Request Flow

```
MCP Client (Cline)
    ↓
mcp-abap-adt-proxy
    ↓
[Header Analysis]
    - Extract x-mcp-url (required)
    - Extract x-btp-destination (required) or use --btp parameter
    - Extract x-mcp-destination (optional) or use --mcp parameter
    ↓
[Validate Headers]
    - Check x-mcp-url is present
    - Check x-btp-destination or --btp is present
    ↓
[Get Tokens from auth-broker]
    - Get BTP Cloud token (from x-btp-destination or --btp)
    - Get SAP ABAP token (from x-mcp-destination or --mcp, if provided)
    ↓
[Build Proxy Request]
    - Add Authorization: Bearer <btp-token>
    - Add SAP headers (x-sap-jwt-token, x-sap-url, etc.) if mcp-destination provided
    - Use URL from x-mcp-url
    ↓
Target MCP Server (from x-mcp-url)
    ↓
Response back to Cline
```

### Key Components

1. **Request Router**
   - Analyzes headers
   - Decides routing strategy
   - Handles request transformation

2. **JWT Token Manager**
   - Integrates with auth-broker
   - Manages token lifecycle
   - Handles token refresh

3. **Proxy Client**
   - HTTP client for cloud-llm-hub
   - Request/response transformation
   - Error handling

4. **MCP Server**
   - Standard MCP server implementation
   - Request/response handling
   - Protocol compliance

## Dependencies

### Core Dependencies
- `@modelcontextprotocol/sdk` - MCP protocol
- `@mcp-abap-adt/auth-broker` - JWT authentication
- `@mcp-abap-adt/header-validator` - Header validation
- `axios` - HTTP client

### Development Dependencies
- `typescript` - TypeScript compiler
- `jest` - Testing framework
- `@types/node` - Node.js types

## Configuration

### Environment Variables
- `CLOUD_LLM_HUB_URL` - Default URL for cloud-llm-hub (can be overridden by x-mcp-url)
- `MCP_HTTP_PORT` - Port for HTTP server (default: 3001)
- `MCP_SSE_PORT` - Port for SSE server (default: 3002)
- `LOG_LEVEL` - Logging level

### Command Line Parameters
- `--btp=<destination>` - Override x-btp-destination header (required if header missing)
- `--mcp=<destination>` - Override x-mcp-destination header (optional)

### Configuration File
```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com",
  "httpPort": 3001,
  "ssePort": 3002,
  "logLevel": "info"
}
```

### Required Headers in Request
- `x-mcp-url` - Full URL of target MCP server (required)
- `x-btp-destination` - Destination for BTP Cloud authorization token (required, or use --btp)

### Optional Headers in Request
- `x-mcp-destination` - Destination for SAP ABAP connection (optional, or use --mcp)

## Success Criteria

- [x] Successfully proxies requests from Cline to target MCP server (via x-mcp-url)
- [x] Automatically manages JWT tokens via auth-broker (BTP and SAP separately)
- [x] Validates required headers (x-mcp-url and x-btp-destination)
- [x] Supports command-line parameter overrides (--btp and --mcp)
- [x] Maintains MCP protocol compliance
- [x] Provides clear error messages
- [x] Well-documented (README, USAGE, API docs)
- [x] Unit tests implemented (50 tests passing)

## Notes

- This proxy should be transparent to MCP clients
- JWT token management should be automatic and seamless
- Error handling should provide clear feedback
- Performance should be comparable to direct connections


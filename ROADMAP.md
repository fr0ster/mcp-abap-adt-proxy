# Development Roadmap: mcp-abap-adt-proxy

## Project Overview

**Package Name**: `@mcp-abap-adt/proxy`  
**Purpose**: MCP proxy server that routes local requests to cloud-llm-hub with JWT authentication  
**Target**: Similar architecture to `mcp-abap-adt` but acts as a proxy layer

## Core Functionality

The proxy intercepts MCP requests and routes them based on authentication headers:

1. **Direct Cloud Requests** (`x-sap-destination: "S4HANA_E19"`)
   - Forward directly to cloud ABAP system
   - No proxy needed

2. **Basic Auth Requests** (`x-sap-auth-type: "basic"`)
   - Handle locally (no cloud connection)
   - No proxy needed

3. **Service Key Requests** (`x-sap-destination: "sk"`)
   - Proxy to `cloud-llm-hub`
   - Add JWT token from `@mcp-abap-adt/auth-broker`
   - Add connection parameters for cloud ABAP

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
  - Detect `x-sap-destination` header
  - Detect `x-sap-auth-type` header
  - Route decision logic
- [x] Add request logging/debugging

### Phase 3: Direct Cloud Routing

- [ ] Implement direct cloud routing for `x-sap-destination: "S4HANA_E19"`
- [ ] Forward requests with original headers
- [ ] Handle responses and errors
- [ ] Add connection pooling/caching

### Phase 4: Basic Auth Handling

- [ ] Implement local handling for `x-sap-auth-type: "basic"`
- [ ] Reuse connection logic from mcp-abap-adt
- [ ] Handle basic auth requests locally

### Phase 5: Cloud Proxy with JWT

- [ ] Implement service key detection (`x-sap-destination: "sk"`)
- [ ] Integrate with `@mcp-abap-adt/auth-broker`:
  - Get JWT token for destination
  - Handle token refresh
  - Cache tokens
- [ ] Build proxy request to `cloud-llm-hub`:
  - Transform MCP request format
  - Add JWT token to headers
  - Add cloud ABAP connection parameters
  - Preserve original request context
- [ ] Forward request to cloud-llm-hub
- [ ] Handle proxy responses:
  - Transform response format
  - Handle errors
  - Preserve MCP protocol structure

### Phase 6: Configuration & Environment

- [ ] Add configuration for cloud-llm-hub URL
- [ ] Support environment variables
- [ ] Add configuration file support
- [ ] Document configuration options

### Phase 7: Error Handling & Resilience

- [ ] Implement comprehensive error handling
- [ ] Add retry logic for failed requests
- [ ] Handle token expiration gracefully
- [ ] Add circuit breaker for cloud-llm-hub
- [ ] Implement request timeout handling

### Phase 8: Testing

- [ ] Unit tests for routing logic
- [ ] Unit tests for header analysis
- [ ] Integration tests with auth-broker
- [ ] Integration tests with cloud-llm-hub
- [ ] End-to-end tests with MCP client
- [ ] Test error scenarios

### Phase 9: Documentation

- [ ] API documentation
- [ ] Configuration guide
- [ ] Usage examples
- [ ] Architecture documentation
- [ ] Troubleshooting guide

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
    ├─→ x-sap-destination: "S4HANA_E19" → Direct to Cloud ABAP
    ├─→ x-sap-auth-type: "basic" → Local Handling
    └─→ x-sap-destination: "sk" → Proxy to cloud-llm-hub
                                    ↓
                            [Get JWT from auth-broker]
                                    ↓
                            [Add headers & forward]
                                    ↓
                            cloud-llm-hub
                                    ↓
                            Cloud ABAP System
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
- `CLOUD_LLM_HUB_URL` - URL of cloud-llm-hub service
- `PROXY_PORT` - Port for proxy server (default: 3001)
- `LOG_LEVEL` - Logging level

### Configuration File
```json
{
  "cloudLlmHubUrl": "https://cloud-llm-hub.example.com",
  "port": 3001,
  "logLevel": "info"
}
```

## Success Criteria

- [ ] Successfully proxies requests from Cline to cloud-llm-hub
- [ ] Automatically manages JWT tokens via auth-broker
- [ ] Handles all three routing scenarios correctly
- [ ] Maintains MCP protocol compliance
- [ ] Provides clear error messages
- [ ] Well-documented and tested

## Notes

- This proxy should be transparent to MCP clients
- JWT token management should be automatic and seamless
- Error handling should provide clear feedback
- Performance should be comparable to direct connections


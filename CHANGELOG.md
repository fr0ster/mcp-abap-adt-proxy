# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2025-12-02

### Added
- **GitHub Actions workflows**
  - **CI workflow** (`.github/workflows/ci.yml`): Runs unit tests on every push and pull request
    - Tests on multiple OS (Ubuntu, macOS, Windows) and Node.js versions (18, 20)
    - Builds project and verifies package creation
    - Tests package installation on Unix and Windows
  - **Release workflow** (`.github/workflows/release.yml`): Automated GitHub releases on tag push
    - Triggers on version tags matching `v*.*.*` pattern
    - Builds project, creates `.tgz` package, and creates GitHub Release with package as asset
    - Verifies version matches between tag and `package.json`
    - Generates release notes automatically

## [0.1.1] - 2025-12-02

### Added
- **Local testing mode without BTP authentication**
  - Proxy can now run with only `--mcp` or `x-mcp-destination` (without `--btp` or `x-btp-destination`)
  - Enables local integration testing without BTP authentication
  - MCP server URL can be obtained from MCP destination service key or specified directly via `--mcp-url`
- **`--mcp-url` parameter support**
  - Direct MCP server URL specification for local testing
  - Auto-generated from ADT server configuration when using `tools/start-servers.js`
  - Can be used instead of service key-based URL lookup
  - Environment variable support: `MCP_URL`
- **Testing tool: `tools/start-servers.js`**
  - Utility script to start both `mcp-abap-adt` and `mcp-abap-adt-proxy` simultaneously
  - Automatic `mcpUrl` generation based on ADT server configuration
  - Both servers use the same transport protocol (HTTP or SSE)
  - Default configuration: ADT on port 3000 (HTTP), Proxy on port 3001 (HTTP)
  - Available via `npm run test:servers`
- **Flexible routing requirements**
  - Proxy accepts either `x-btp-destination/--btp`, `x-mcp-destination/--mcp`, or `x-mcp-url/--mcp-url`
  - Removed strict requirement for BTP destination when using MCP destination or URL

### Changed
- **Routing logic updated**
  - `x-btp-destination` is now optional (was required)
  - Proxy can work with only `x-mcp-destination` or `x-mcp-url` for local testing
  - MCP URL can be obtained from multiple sources (priority order):
    1. `x-mcp-url` header or `--mcp-url` parameter (direct URL)
    2. Service key for `x-btp-destination` (if provided)
    3. Service key for `x-mcp-destination` (if only MCP destination is provided)
- **Token retrieval made optional for MCP destination**
  - Token retrieval for `mcpDestination` is now optional (won't fail if token unavailable)
  - Allows local testing without full service key configuration
- **Error messages improved**
  - More descriptive error messages when neither BTP nor MCP destination is provided
  - Clear indication of local testing mode vs BTP authentication mode

### Fixed
- Proxy now correctly handles cases where only MCP destination is provided without BTP destination
- Fixed TypeScript compilation errors in `directCloudRouter.ts` (replaced `routingDecision.destination` with `btpDestination` or `mcpDestination`)
- Fixed routing decision interface to properly support both BTP and MCP destinations

## [0.1.0] - 2025-12-02

### Added
- Initial project setup and infrastructure
- TypeScript configuration and build scripts
- Basic project structure (src/, bin/)
- Logger utility
- Configuration management (environment variables, config files, command-line arguments)
- MCP server skeleton with HTTP, SSE, and stdio transport support
- Launcher script (bin/mcp-abap-adt-proxy.js)
- Request interception and routing logic
- JWT token management via `@mcp-abap-adt/auth-broker`
- Service key-based authentication
- Error handling with retry logic and circuit breaker
- **Safe session storage by default** – Session data stored in-memory using `SafeSessionStore`:
  - Session tokens are not persisted to disk by default (secure by default)
  - Session data is lost after server restart (requires re-authentication)
  - File-based storage (`FileSessionStore`) available via `--unsafe` flag
- **`--unsafe` flag** – Enables file-based session storage (persists tokens to disk):
  - When specified, session data is saved to platform-specific locations
  - Can be set via environment variable: `MCP_PROXY_UNSAFE=true`
  - Use this flag if you need session persistence across server restarts
- Command-line options: `--btp`, `--mcp`, `--unsafe`
- Configuration file support (`mcp-proxy-config.json`)
- README and ROADMAP documentation

### Dependencies
- `@modelcontextprotocol/sdk` - MCP SDK
- `@mcp-abap-adt/auth-broker` ^0.1.5 - JWT token management
  - Benefits from new `SafeSessionStore` implementation (in-memory, secure)
  - Updated to use new `ISessionStore` interface (replaces `SessionStore`)
- `@mcp-abap-adt/connection` ^0.1.13 - Connection layer
  - Uses new CSRF token endpoint `/sap/bc/adt/core/discovery` (lighter response, available on all systems)
  - CSRF configuration constants (`CSRF_CONFIG`, `CSRF_ERROR_MESSAGES`) are now exported for consistency
- `@mcp-abap-adt/header-validator` ^0.1.3 - Header validation
- `axios` - HTTP client
- `zod` - Schema validation


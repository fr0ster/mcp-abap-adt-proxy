# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.3] - 2026-04-07

### Fixed
- **Automatic token refresh on 401/403 errors** — proxy now detects expired tokens, clears the cache, and retries the request with a freshly obtained token instead of failing immediately

## [1.0.2] - 2026-04-07

### Fixed
- **Skip header validation in SSE transport path** — proxy no longer runs `validateProxyHeaders()` on SSE requests, matching HTTP transport behavior. Proxy should not validate client headers beyond authorization and defaults.
- **Added debug-level header forwarding log** in reverse proxy for diagnostics (`LOG_LEVEL=debug`)

## [1.0.1] - 2026-04-07

### Added
- **Default headers injection (`defaultHeaders` / `--header`)**
  - Proxy can inject configurable headers into every forwarded request
  - YAML config: `defaultHeaders` map (e.g., `x-sap-destination: S4HANA_E19`)
  - CLI: repeatable `--header key=value` flag
  - Client headers override defaults (low priority injection)
  - Enables MCP clients (Cline, Claude Code) that cannot set custom headers to pass SAP headers to the MCP server on BTP

## [1.0.0] - 2026-04-07

### Breaking Changes
- **Header renamed: `x-btp-destination` → `x-sap-destination`**
  - The proxy now uses `x-sap-destination` header (same as MCP server) instead of the proxy-specific `x-btp-destination`
  - The `--btp` CLI parameter is unchanged
  - Clients sending `x-btp-destination` header must update to `x-sap-destination`

### Added
- **Transparent reverse proxy for BTP request forwarding**
  - Replaced buffered axios-based proxy with Node.js native HTTP streaming reverse proxy
  - Supports any HTTP API including OpenAI-compatible streaming endpoints
  - `targetUrl` parameter for explicit target URL override (`--target-url`/`--url` or `x-target-url` header)
- **Interactive configuration wizard (TUI)**
  - `npx @mcp-abap-adt/proxy --tui` launches interactive setup wizard
  - Service key existence checker validates BTP destination before configuration
  - Generates YAML config files with inline comments
  - Supports BTP and Direct URL scenarios with advanced settings
- **Dependencies updated**
  - `@mcp-abap-adt/interfaces` bumped to v5
  - `@mcp-abap-adt/auth-stores` bumped to v1.0.4
  - Added `@inquirer/prompts` for TUI wizard

### Fixed
- **Header validation skipped in reverse proxy mode** when config provides destination
- **YAML config file now correctly loads transport/port settings** (`--config` flag)
- **targetUrl loading from YAML config** now works correctly

## [0.1.9] - 2026-02-12

### Changed
- **AUTH_BROKER_PATH resolution aligned with `mcp-abap-adt`**
  - `AUTH_BROKER_PATH` is now treated as a base directory.
  - Proxy now resolves stores from `<base>/service-keys` and `<base>/sessions`.
  - If a path already ends with `service-keys` or `sessions`, it is normalized and still resolved correctly.

### Documentation
- Clarified in README and troubleshooting docs how default store paths and `AUTH_BROKER_PATH` are resolved.

## [0.1.8] - 2026-02-05

### Added
- **Browser-based Authentication (Authorization Code)**
  - Enforced `AuthorizationCodeProvider` as the sole authentication method for BTP destinations.
  - Added CLI options `--browser`, `--browser-auth-port` (default: 3333).
- **Eager Authentication**
  - Proxy now initiates authentication (opens browser) immediately on startup if `--btp` is provided.
- **Service URL Injection**
  - Added support for `--url` parameter to inject MCP server URL when missing from service key.
  - Added placeholders for missing auth config to allow manual URL injection.

### Fixed
- **Port Conflict**: Changed default browser callback port to 3333 (was 3001) to avoid conflict with proxy server.
- **Service Key Loading**: Fixed issue where `AuthorizationCodeProvider` was initialized with empty config, causing validation errors.
- **JSON-RPC ID Handling**: Fixed schema validation issue where backend returning `id: null` caused client errors (proxy now restores original ID).

## [0.1.7] - 2025-12-31

### Changed
- **@mcp-abap-adt/auth-broker**: bumped to `^0.3.0` - auto-detect service key format, credentials wrapper support, debug logging
- **@mcp-abap-adt/auth-stores**: bumped to `^0.3.0`

## [0.1.6] - 2025-12-07

### Added
- **Separate AuthBroker instances for BTP and ABAP destinations**
  - `btpAuthBroker` with `XsuaaTokenProvider` for BTP destinations (`--btp` or `x-sap-destination`)
  - `abapAuthBroker` with `BtpTokenProvider` for ABAP destinations (`--mcp` or `x-mcp-destination`)
  - Proper separation ensures correct token provider is used for each destination type
- **Client Setup Guide** (`docs/CLIENT_SETUP.md`)
  - Step-by-step setup instructions for Cline and GitHub Copilot
  - Configuration examples for different scenarios (local MCP, BTP MCP, BTP + ABAP)
  - Troubleshooting section with common issues and solutions
  - Quick reference for command-line options and service key locations

### Changed
- **Improved service key store selection**
  - `CombinedServiceKeyStore` now prefers XSUAA store for BTP destinations (`preferXsuaa=true`)
  - Prevents errors when BTP service keys (XSUAA format) are parsed by ABAP store
  - For BTP destinations, only tries XSUAA store (doesn't fallback to ABAP store)
- **Error messages updated**
  - Error messages no longer mention `.env` files (proxy only uses service keys)
  - Service key errors now show correct paths and file requirements
- **Platform path resolution**
  - Updated `getPlatformPaths` to match logic from `mcp-abap-adt`
  - Correctly determines service key and session paths for Unix and Windows
  - Unix: `~/.config/mcp-abap-adt/service-keys` and `~/.config/mcp-abap-adt/sessions`
  - Windows: `%USERPROFILE%\Documents\mcp-abap-adt\service-keys` and `%USERPROFILE%\Documents\mcp-abap-adt\sessions`

### Fixed
- **BTP destination authentication**
  - Fixed issue where BTP destinations were incorrectly using ABAP token provider
  - BTP destinations now correctly use `XsuaaTokenProvider` (client_credentials grant type)
  - ABAP destinations use `BtpTokenProvider` (browser OAuth2 or refresh token flow)
- **Service key lookup for BTP destinations**
  - Fixed "Service key missing 'uaa' object" error for BTP destinations
  - BTP service keys (XSUAA format) are now correctly parsed by `XsuaaServiceKeyStore`
  - Prevents ABAP store from attempting to parse XSUAA format service keys

### Documentation
- Added comprehensive client setup guide with examples for Cline and GitHub Copilot
- Updated README to reflect dual AuthBroker architecture
- Clarified authentication flow: XSUAA block (BTP) → ABAP block (SAP) → MCP server

## [0.1.4] - 2025-12-02

### Added
- **Documentation for BTP-Only authentication mode**
  - Added "Scenario 2: BTP Authentication Only (No SAP Configuration)" in `docs/USAGE.md`
  - Documented use case for connecting to any BTP service without SAP ABAP configuration
  - Explained that `x-mcp-destination` is optional when using `x-sap-destination` or `--btp`
  - Updated README.md with "BTP-Only Mode" section explaining behavior when only `--btp` is provided
- **Enhanced help text in `bin/mcp-abap-adt-proxy.js`**
  - Added detailed "Usage Modes" section with three modes:
    1. BTP Authentication Mode (with `--btp` only)
    2. BTP + SAP Configuration Mode (`--btp + --mcp`)
    3. Local Testing Mode (only `--mcp` or `--mcp-url`)
  - Added examples for each usage mode
  - Added information about headers for HTTP/SSE transports
  - Added service keys location and structure documentation
  - Clarified that `abap.url` in service key is used as MCP server URL (even for non-SAP services)

### Documentation
- Improved clarity on when to use each authentication mode
- Added examples showing BTP-only usage (without SAP configuration)
- Documented that proxy works with any BTP service, not just SAP ABAP

## [0.1.3] - 2025-12-02

### Fixed
- **Unit tests updated to match new routing logic**
  - Fixed tests that expected `UNKNOWN` strategy when only `x-mcp-destination` or `x-mcp-url` is provided
  - Updated test expectations to reflect that `x-sap-destination` is now optional
  - Added tests for `x-mcp-url` header support
  - Updated `shouldProxy` function tests to cover all routing scenarios (BTP, MCP destination, MCP URL)
  - All 51 unit tests now pass successfully

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
  - Proxy can now run with only `--mcp` or `x-mcp-destination` (without `--btp` or `x-sap-destination`)
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
  - Proxy accepts either `x-sap-destination/--btp`, `x-mcp-destination/--mcp`, or `x-mcp-url/--mcp-url`
  - Removed strict requirement for BTP destination when using MCP destination or URL

### Changed
- **Routing logic updated**
  - `x-sap-destination` is now optional (was required)
  - Proxy can work with only `x-mcp-destination` or `x-mcp-url` for local testing
  - MCP URL can be obtained from multiple sources (priority order):
    1. `x-mcp-url` header or `--mcp-url` parameter (direct URL)
    2. Service key for `x-sap-destination` (if provided)
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

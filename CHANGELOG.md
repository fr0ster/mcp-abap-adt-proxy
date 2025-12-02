# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Support for `--btp` and `--mcp` parameters in stdio and SSE transports**
  - `--btp` parameter is now required for stdio transport (replaces missing HTTP headers)
  - `--mcp` parameter can be used as default destination for stdio and SSE transports
  - Parameters work as config overrides when headers are not provided
  - SSE transport now fully implemented with support for `--btp` and `--mcp` parameters
  - Updated help text and documentation to reflect new parameter usage

### Changed
- SSE transport implementation completed (previously was TODO)
- Improved error messages for stdio transport when `--btp` parameter is missing

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


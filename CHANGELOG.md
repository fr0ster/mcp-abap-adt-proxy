# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Dependencies
- Updated `@mcp-abap-adt/connection` to `^0.1.13`:
  - Uses new CSRF token endpoint `/sap/bc/adt/core/discovery` (lighter response, available on all systems)
  - CSRF configuration constants (`CSRF_CONFIG`, `CSRF_ERROR_MESSAGES`) are now exported for consistency
- Updated `@mcp-abap-adt/auth-broker` to `^0.1.4`:
  - Benefits from optimized CSRF token endpoint in connection layer
  - Faster authentication flows when managing JWT tokens

### Added
- Initial project setup
- TypeScript configuration
- Basic project structure (src/, bin/)
- Logger utility
- Configuration management
- MCP server skeleton
- Launcher script (bin/mcp-abap-adt-proxy.js)
- Package.json with dependencies:
  - `@modelcontextprotocol/sdk` - MCP SDK
  - `@mcp-abap-adt/auth-broker` - JWT token management
  - `@mcp-abap-adt/header-validator` - Header validation
  - `axios` - HTTP client
- Build scripts and npm configuration
- README and ROADMAP documentation

### Infrastructure
- GitHub repository created
- Basic project structure established
- TypeScript compilation working
- Dependencies installed


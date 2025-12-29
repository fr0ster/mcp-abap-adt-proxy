# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP ABAP ADT Proxy (`@mcp-abap-adt/proxy`) is a middleware server that sits between MCP clients (like Cline, Claude Code) and MCP servers. It adds JWT authentication tokens to requests and forwards them to target MCP servers specified via headers or CLI parameters.

## Common Commands

```bash
# Build (runs Biome check + TypeScript compilation)
npm run build

# Fast build (TypeScript only, no linting)
npm run build:fast

# Run tests
npm test

# Run a single test file
npx jest src/__tests__/router/headerAnalyzer.test.ts

# Type-check tests without running them
npm run test:check

# Lint and auto-fix
npm run lint

# Lint check only (no auto-fix)
npm run lint:check

# Format code
npm run format

# Start server (stdio transport - default)
npm start

# Start server (HTTP transport)
npm run start:http

# Start server (SSE transport)
npm run start:sse

# Run with MCP Inspector for debugging
npm run dev

# Start both ADT and Proxy servers for testing
npm run test:servers
```

## Architecture

### Request Flow

```
MCP Client → Proxy (intercepts request) → Header Analysis →
  → JWT Token (via AuthBroker) → Forward to MCP Server (x-mcp-url)
```

### Key Components

- **src/index.ts** - Main server class (`McpAbapAdtProxyServer`) supporting stdio, HTTP, and SSE transports
- **src/router/headerAnalyzer.ts** - Extracts routing info from `x-mcp-url`, `x-btp-destination`, `x-mcp-destination` headers
- **src/router/requestInterceptor.ts** - Intercepts and analyzes incoming HTTP requests
- **src/proxy/cloudLlmHubProxy.ts** - Handles proxying with JWT token injection, retry logic, and circuit breaker
- **src/lib/config.ts** - Configuration loading from env vars and config files
- **src/lib/errorHandler.ts** - Error handling with exponential backoff and circuit breaker

### Routing Strategies

The proxy determines routing based on headers/CLI params:
- `x-mcp-url` (required) - Target MCP server URL
- `x-btp-destination` / `--btp` - BTP destination for XSUAA authentication
- `x-mcp-destination` / `--mcp` - MCP destination for ABAP connection config

### External Dependencies

This package uses sibling packages from the `@mcp-abap-adt` monorepo:
- `@mcp-abap-adt/auth-broker` - Authentication broker for JWT tokens
- `@mcp-abap-adt/auth-providers` - Token providers (XSUAA, BTP)
- `@mcp-abap-adt/auth-stores` - Service key storage
- `@mcp-abap-adt/connection` - Connection management
- `@mcp-abap-adt/interfaces` - Shared TypeScript interfaces
- `@mcp-abap-adt/header-validator` - Header validation utilities

## Code Style

- TypeScript with strict mode
- Biome for linting and formatting (single quotes, semicolons, 2-space indent)
- Jest with ts-jest for testing
- ESM modules with `.js` extensions in imports

## Testing

Tests are in `src/__tests__/` directory. The proxy sets `MCP_SKIP_AUTO_START=true` in test environment to prevent auto-starting the server.

```bash
# Run all tests
npm test

# Run specific test file
npx jest src/__tests__/proxy/cloudLlmHubProxy.test.ts

# Run with coverage
npx jest --coverage
```

## Configuration

Configuration sources (in order of precedence):
1. Environment variables (e.g., `CLOUD_LLM_HUB_URL`, `MCP_HTTP_PORT`)
2. Config file (`mcp-proxy-config.json` in cwd or home directory)
3. Default values

See `docs/CONFIGURATION.md` for full configuration reference.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP ABAP ADT Proxy (`@mcp-abap-adt/proxy`) is an authorization proxy for connecting MCP clients (like Cline, Claude Code) that cannot authenticate on their own to MCP servers or other services deployed on SAP BTP. The proxy intercepts requests, obtains JWT tokens, and forwards authenticated requests to the target service.

The proxy does not handle ABAP system connections directly — that is the responsibility of the downstream MCP server or BTP-deployed service.

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
  → JWT Token (via AuthBroker) → Forward to MCP Server
```

### Key Components

- **src/index.ts** - Main server class (`McpAbapAdtProxyServer`) supporting stdio, HTTP, and SSE transports
- **src/router/headerAnalyzer.ts** - Extracts routing info from `x-mcp-url` and `x-btp-destination` headers; returns a `RoutingDecision` with strategy (PROXY, PASSTHROUGH)
- **src/router/requestInterceptor.ts** - Intercepts incoming HTTP requests, calls `analyzeHeaders()`, extracts session ID
- **src/proxy/cloudLlmHubProxy.ts** - Handles proxying with BTP/XSUAA auth injection, retry logic with exponential backoff, circuit breaker, and token caching (30-min TTL)
- **src/lib/config.ts** - Configuration loading from YAML/JSON config files or env vars + CLI params (mutually exclusive: `--config` file ignores other CLI params)
- **src/lib/errorHandler.ts** - Retry logic (`retryWithBackoff()`) and circuit breaker (opens after threshold failures, resets after timeout)
- **src/lib/transportConfig.ts** - Transport type detection: explicit `--transport` flag → `MCP_TRANSPORT` env var → auto-detect (stdio if not TTY, else streamable-http)
- **src/lib/stores.ts** - Platform-specific auth store paths (Windows vs Unix) for service key files

### BTP Authentication in `buildProxyRequest()`

If `x-btp-destination` or `--btp` is present, the proxy gets a JWT from `btpAuthBroker` (ClientCredentials grant) and injects `Authorization: Bearer <token>`. Auth brokers are cached per destination for reuse across requests.

### Routing Strategies

The proxy determines routing based on headers/CLI params:
- `x-mcp-url` (or `--mcp-url`) - Direct MCP server URL (no authentication)
- `x-btp-destination` (or `--btp`) - BTP destination for XSUAA authentication; MCP URL from service key
- At least one must be present; otherwise request is treated as PASSTHROUGH (forwarded unchanged)

### External Dependencies

This package uses sibling packages from the `@mcp-abap-adt` monorepo:
- `@mcp-abap-adt/auth-broker` - Authentication broker for JWT tokens
- `@mcp-abap-adt/auth-providers` - Token providers (ClientCredentials)
- `@mcp-abap-adt/auth-stores` - Service key storage
- `@mcp-abap-adt/interfaces` - Shared TypeScript interfaces
- `@mcp-abap-adt/header-validator` - Header validation utilities
- `@mcp-abap-adt/logger` - Logging utility

## Code Style

- TypeScript with strict mode (target ES2022, module node16)
- Biome for linting and formatting (single quotes, semicolons, 2-space indent)
- Biome relaxes rules in test files (allows `any`, unused vars/imports)
- Jest with ts-jest for testing; `moduleNameMapper` strips `.js` extensions for test resolution
- ESM modules with `.js` extensions in imports (required by node16 module resolution)

## Testing

Tests are in `src/__tests__/` directory. The proxy sets `MCP_SKIP_AUTO_START=true` in test environment to prevent auto-starting the server.

Jest uses `moduleNameMapper` (`'^(\\.{1,2}/.*)\\.js$': '$1'`) to handle ESM `.js` import extensions in tests.

```bash
# Run all tests
npm test

# Run specific test file
npx jest src/__tests__/proxy/cloudLlmHubProxy.test.ts

# Run with coverage
npx jest --coverage
```

## Configuration

Configuration loading is mutually exclusive:

1. **With `--config`/`-c` flag**: Loads ONLY from the specified YAML/JSON file (other CLI params are ignored with a warning)
2. **Without `--config`**: Uses CLI params (`--btp`, `--mcp-url`, `--unsafe`) + environment variables + defaults

Key environment variables: `CLOUD_LLM_HUB_URL`, `MCP_HTTP_PORT`, `MCP_SSE_PORT`, `LOG_LEVEL`, `MCP_PROXY_MAX_RETRIES`, `MCP_PROXY_REQUEST_TIMEOUT`, `MCP_PROXY_CIRCUIT_BREAKER_THRESHOLD`.

See `docs/CONFIGURATION.md` for full configuration reference.

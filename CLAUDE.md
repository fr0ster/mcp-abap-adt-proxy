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

# Verify a BTP destination (service key + token retrieval)
npm run test-destination
```

## Architecture

### Request Flow

```
MCP Client → Proxy (intercepts request) → Header Analysis →
  → JWT Token (via AuthBroker) → Forward to MCP Server
```

### Key Components

- **src/index.ts** - Main server class (`McpAbapAdtProxyServer`) supporting stdio, HTTP, and SSE transports
- **src/router/headerAnalyzer.ts** - Extracts routing info from `x-sap-destination` and `x-target-url` headers; returns a `RoutingDecision` with strategy (PROXY, UNKNOWN)
- **src/router/requestInterceptor.ts** - Intercepts incoming HTTP requests, calls `analyzeHeaders()`, extracts session ID
- **src/proxy/cloudLlmHubProxy.ts** - Handles proxying with BTP/XSUAA auth injection, retry logic with exponential backoff, circuit breaker, and token caching (30-min TTL)
- **src/lib/config.ts** - Configuration loading from YAML/JSON config files or env vars + CLI params. With `--config`, CLI flags override matching values from the file (file is the baseline; `defaultHeaders` merge per key)
- **src/lib/errorHandler.ts** - Retry logic (`retryWithBackoff()`) and circuit breaker (opens after threshold failures, resets after timeout)
- **src/lib/transportConfig.ts** - Transport type detection: explicit `--transport` flag → `MCP_TRANSPORT` env var → auto-detect (stdio if not TTY, else streamable-http)
- **src/lib/stores.ts** - Platform-specific auth store paths (Windows vs Unix) for service key files

### BTP Authentication in `buildProxyRequest()`

If `x-sap-destination` or `--btp` is present, the proxy gets a JWT from `btpAuthBroker` (ClientCredentials grant) and injects `Authorization: Bearer <token>`. Auth brokers are cached per destination for reuse across requests.

### Routing Strategies

The proxy determines routing based on headers/CLI params:
- `x-sap-destination` (or `--btp`) - BTP destination for XSUAA authentication; MCP URL from service key (strategy: PROXY)
- `x-target-url` (or `--target-url`) - Optional override of the target URL; auth still comes from the BTP destination
- A BTP destination is **required**. Without it the decision is `UNKNOWN` and the request cannot be routed. (Direct unauthenticated `x-mcp-url`/`--mcp-url` routing was removed.)

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

Configuration loading:

1. **With `--config`/`-c` flag**: file is the baseline. Explicit CLI flags (`--btp`, `--target-url`, `--unsafe`, `--browser`, `--browser-auth-port`, `--header`) override matching values from the file; `--header` entries merge with `defaultHeaders` (CLI keys win). Overridden keys are logged on startup.
2. **Without `--config`**: Uses CLI params (`--btp`, `--target-url`, `--unsafe`, `--header`, `--browser`, `--browser-auth-port`) + environment variables + defaults

Key environment variables: `MCP_HTTP_PORT`, `MCP_SSE_PORT`, `MCP_HTTP_HOST`, `MCP_SSE_HOST`, `MCP_TRANSPORT`, `LOG_LEVEL`, `MCP_PROXY_UNSAFE`, `MCP_PROXY_MAX_RETRIES`, `MCP_PROXY_REQUEST_TIMEOUT`, `MCP_PROXY_CIRCUIT_BREAKER_THRESHOLD`.

The `--header key=value` CLI flag (repeatable) and `defaultHeaders` YAML map inject default headers into every forwarded request. Client-supplied headers take precedence over defaults.

Config string values and `--header` values support `${VAR}` / `${VAR:-default}` interpolation, resolved from `process.env` then a `.env` file (`envFile:` in the config, resolved relative to the config file's directory, or `--env-file <path>` which overrides it). `process.env` wins; an unresolved `${VAR}` without a default fails at startup. This is the per-user injection point for ABAP credentials (`x-sap-login` / `x-sap-password`) so secrets stay out of the YAML. Interpolation lives in `src/lib/envInterpolation.ts`.

See `docs/CONFIGURATION.md` for full configuration reference.

## Plans and Specs

Plans under `docs/superpowers/plans/` and specs under `docs/superpowers/specs/` are kept in the tree only while active — i.e. not yet implemented and not cancelled. Once a plan/spec has been fully implemented OR cancelled, delete the file. History lives in git; these directories hold only work in progress.

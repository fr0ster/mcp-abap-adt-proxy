# Routing Logic Specification

## Overview

The proxy routes requests to MCP servers (local or on BTP) and handles BTP/XSUAA authentication.

## Key Principles

1. **No .env files in proxy**: Proxy should NOT use `.env` files for connection configuration. Only destinations via auth-broker (service key files) are used.
2. **Validation only for destination**: Proxy validates only the `x-sap-destination` header. Other headers are passed directly to MCP server.
3. **Destination priority**: Destination can be specified via command-line parameter (`--btp`) or header (`x-sap-destination`). Parameter takes precedence.
4. **Header passthrough**: All other headers (except `x-sap-destination`) are passed directly to MCP server without validation.

## Routing Scenarios

### Scenario 1: BTP MCP Server (`--btp`)

**Configuration:**
- `--btp=<btp-destination>` (or header `x-sap-destination`) - BTP destination for authentication

**Behavior:**
- MCP server URL: From BTP destination service key (`abap.url` field)
- **BTP Authentication**: Uses `btpAuthBroker` with `ClientCredentialsProvider` to get BTP Cloud token
  - Token obtained from BTP destination service key (contains `uaa.url`, `uaa.clientid`, `uaa.clientsecret`)
  - Injects/overwrites `Authorization: Bearer <token>` header

**Use Case:** Production/cloud deployment with MCP server on BTP

**Example:**
```bash
mcp-abap-adt-proxy --btp=btp-cloud
```

### Scenario 2: BTP MCP Server with explicit target URL (`--btp` + `--target-url`)

**Configuration:**
- `--btp=<btp-destination>` (or header `x-sap-destination`) - BTP destination for authentication
- `--target-url=<url>` (or header `x-target-url`) - Override the target URL

**Behavior:**
- MCP server URL: From `--target-url` (overrides the `abap.url` from the service key)
- **BTP Authentication**: Auth token still comes from the `--btp` destination service key
  - Injects/overwrites `Authorization: Bearer <token>` header

**Use Case:** Auth comes from one service key, but requests must go to a different URL
(e.g. direct OData testing or a non-standard MCP path)

**Example:**
```bash
mcp-abap-adt-proxy --btp=btp-cloud \
  --target-url=https://mcp-server.cfapps.eu10.hana.ondemand.com
```

> **Note:** Direct unauthenticated routing via `--mcp-url` / `x-mcp-url` has been
> **removed**. A BTP destination (`--btp` or `x-sap-destination`) is required; without
> it the proxy cannot resolve a target or obtain a token.

## Header Mapping

### Validated Headers

| Header | Source | Description |
|--------|--------|-------------|
| `x-sap-destination` | Request header or `--btp` parameter | BTP destination name for authentication |

**Note:** This is the ONLY header that proxy validates. All other headers are passed directly to MCP server.

### Headers Added by Proxy

| Source | Target Header | Description |
|--------|---------------|-------------|
| BTP destination token (via `btpAuthBroker` with `ClientCredentialsProvider`) | `Authorization: Bearer <token>` | For MCP server on BTP (when `x-sap-destination` or `--btp` is provided) |

### Headers Passed Through

All headers from the original request (except `x-sap-destination`) are passed directly to MCP server without modification. This includes any custom headers the MCP server might need.

## Current Implementation Analysis

### What Works Correctly

1. **BTP AuthBroker architecture**: `btpAuthBroker` with `ClientCredentialsProvider` for BTP destinations (service keys with `uaa` section)
2. **BTP destination handling**: Correctly gets token from BTP destination using `btpAuthBroker` for MCP server authorization
3. **Service key store**: `XsuaaServiceKeyStore` correctly reads service keys for BTP destinations
4. **Command-line overrides**: `--btp`, `--target-url` work as expected
5. **Header passthrough**: Original headers are preserved and forwarded to MCP server
6. **Platform path resolution**: Correctly determines service key and session paths for Unix and Windows

## Testing Scenarios

### Test 1: BTP MCP with explicit target URL
```bash
# Start proxy
mcp-abap-adt-proxy --btp=btp-cloud \
  --target-url=https://mcp-server.cfapps.eu10.hana.ondemand.com

# Send request with headers
curl -X POST http://localhost:3001/mcp/stream/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

**Expected:**
- Request forwarded to the `--target-url` value with `Authorization: Bearer <btp-token>`

### Test 2: BTP MCP with BTP Destination
```bash
# Start proxy
mcp-abap-adt-proxy --btp=btp-cloud

# Send request
curl -X POST http://localhost:3001/mcp/stream/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

**Expected:**
- MCP server receives: `Authorization: Bearer <btp-token>` (from BTP destination)
- MCP server URL obtained from BTP destination service key

## Summary

The proxy supports flexible routing:
- **BTP Authentication Mode**: Use `--btp` for BTP authentication, MCP URL from service key
- **Explicit URL Mode**: Use `--btp` + `--target-url` for BTP auth with an overridden target URL
- **No .env files**: Only use destinations via auth-broker, never .env files

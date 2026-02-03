# Routing Logic Specification

## Overview

The proxy routes requests to MCP servers (local or on BTP) and handles BTP/XSUAA authentication.

## Key Principles

1. **No .env files in proxy**: Proxy should NOT use `.env` files for connection configuration. Only destinations via auth-broker (service key files) are used.
2. **Validation only for destination**: Proxy validates only the `x-btp-destination` header. Other headers are passed directly to MCP server.
3. **Destination priority**: Destination can be specified via command-line parameter (`--btp`) or header (`x-btp-destination`). Parameter takes precedence.
4. **Header passthrough**: All other headers (except `x-btp-destination`) are passed directly to MCP server without validation.

## Routing Scenarios

### Scenario 1: Local MCP Server (Only `--mcp-url`)

**Configuration:**
- `--mcp-url=<mcp-server-url>` - Direct URL to local MCP server

**Behavior:**
- MCP server URL: From `--mcp-url` parameter
- All headers from request are passed directly to MCP server (no validation, no destination lookups)
- No BTP authentication required
- No destination lookups needed

**Use Case:** Local development/testing with MCP server running locally

**Example:**
```bash
mcp-abap-adt-proxy --mcp-url=http://localhost:3000
```

### Scenario 2: BTP MCP Server (`--btp`)

**Configuration:**
- `--btp=<btp-destination>` - BTP destination for authentication

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

### Scenario 3: BTP MCP Server with explicit URL (`--mcp-url` + `--btp`)

**Configuration:**
- `--mcp-url=<mcp-server-url>` - Direct URL to MCP server on BTP
- `--btp=<btp-destination>` - BTP destination for authentication

**Behavior:**
- MCP server URL: From `--mcp-url` parameter (overrides service key URL)
- **BTP Authentication**: Uses `btpAuthBroker` with `ClientCredentialsProvider` to get BTP Cloud token
  - Injects/overwrites `Authorization: Bearer <token>` header

**Use Case:** When you want to specify the MCP URL explicitly while still using BTP authentication

**Example:**
```bash
mcp-abap-adt-proxy --mcp-url=https://mcp-server.cfapps.eu10.hana.ondemand.com --btp=btp-cloud
```

### Scenario 4: MCP URL Only (No Destinations)

**Configuration:**
- `--mcp-url=<mcp-server-url>` - Direct URL to MCP server
- No `--btp` parameter

**Behavior:**
- MCP server URL: From `--mcp-url` parameter
- All headers from request are passed directly to MCP server (no validation, no destination lookups)
- No destination lookups
- All parameters come from request headers

**Use Case:** Flexible routing where all parameters are provided in request headers

**Example:**
```bash
mcp-abap-adt-proxy --mcp-url=http://localhost:3000
```

## Header Mapping

### Validated Headers

| Header | Source | Description |
|--------|--------|-------------|
| `x-btp-destination` | Request header or `--btp` parameter | BTP destination name for authentication |

**Note:** This is the ONLY header that proxy validates. All other headers are passed directly to MCP server.

### Headers Added by Proxy

| Source | Target Header | Description |
|--------|---------------|-------------|
| BTP destination token (via `btpAuthBroker` with `ClientCredentialsProvider`) | `Authorization: Bearer <token>` | For MCP server on BTP (when `x-btp-destination` or `--btp` is provided) |

### Headers Passed Through

All headers from the original request (except `x-btp-destination`) are passed directly to MCP server without modification. This includes any custom headers the MCP server might need.

## Current Implementation Analysis

### What Works Correctly

1. **BTP AuthBroker architecture**: `btpAuthBroker` with `ClientCredentialsProvider` for BTP destinations (service keys with `uaa` section)
2. **BTP destination handling**: Correctly gets token from BTP destination using `btpAuthBroker` for MCP server authorization
3. **Service key store**: `XsuaaServiceKeyStore` correctly reads service keys for BTP destinations
4. **Command-line overrides**: `--btp`, `--mcp-url` work as expected
5. **Header passthrough**: Original headers are preserved and forwarded to MCP server
6. **Platform path resolution**: Correctly determines service key and session paths for Unix and Windows

## Testing Scenarios

### Test 1: Local MCP with Direct URL
```bash
# Start proxy
mcp-abap-adt-proxy --mcp-url=http://localhost:3000

# Send request with headers
curl -X POST http://localhost:3001/mcp/stream/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

**Expected:**
- Request forwarded directly to `http://localhost:3000`
- All headers passed through without modification

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
- **Local Testing Mode**: Use `--mcp-url` for direct MCP server URL (no authentication)
- **Combined Mode**: Use both `--btp` and `--mcp-url` for BTP auth with explicit URL
- **No .env files**: Only use destinations via auth-broker, never .env files

# Routing Logic Specification

## Overview

The proxy routes requests to MCP servers (local or on BTP) and handles authentication for both MCP server connection and ABAP system connection.

## Key Principles

1. **No .env files in proxy**: Proxy should NOT use `.env` files for connection configuration. Only destinations via auth-broker (service key files) are used.
2. **Validation only for destinations**: Proxy validates only two headers: `x-btp-destination` and `x-mcp-destination`. Other headers are passed directly to MCP server.
3. **Destination priority**: Destinations can be specified via command-line parameters (`--btp`, `--mcp`) or headers (`x-btp-destination`, `x-mcp-destination`). Parameters take precedence.
4. **Header passthrough**: All other headers (except `x-btp-destination` and `x-mcp-destination`) are passed directly to MCP server without validation.

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

**Request Headers (passed as-is to MCP server):**
```
x-sap-url: <abap-system-url>
x-sap-jwt-token: <token-for-abap>
x-sap-client: 100
# Any other headers are passed directly
```

### Scenario 2: BTP MCP Server (`--mcp-url` + `--btp`)

**Configuration:**
- `--mcp-url=<mcp-server-url>` - Direct URL to MCP server on BTP
- `--btp=<btp-destination>` - BTP destination for authentication

**Behavior:**
- MCP server URL: From `--mcp-url` parameter
- Authorization for MCP: `Authorization: Bearer <token>` from BTP destination (via auth-broker)
  - Token obtained from BTP destination service key (xsuaa format)
  - Uses `@mcp-abap-adt/auth-broker` with BTP destination
- ABAP connection parameters: From request headers OR from `--mcp` destination (if provided)
- BTP authentication required

**Use Case:** Production/cloud deployment with MCP server on BTP

**Example:**
```bash
mcp-abap-adt-proxy --mcp-url=https://mcp-server.cfapps.eu10.hana.ondemand.com --btp=btp-cloud
```

**Request Headers (optional):**
```
x-sap-url: <abap-system-url>  # If not using --mcp
x-sap-jwt-token: <token-for-abap>  # If not using --mcp
x-sap-client: 100
```

**OR with `--mcp` destination:**
```bash
mcp-abap-adt-proxy --mcp-url=https://mcp-server.cfapps.eu10.hana.ondemand.com --btp=btp-cloud --mcp=abap-system
```

### Scenario 3: BTP MCP Server with ABAP Destination (`--mcp-url` + `--btp` + `--mcp`)

**Configuration:**
- `--mcp-url=<mcp-server-url>` - Direct URL to MCP server on BTP
- `--btp=<btp-destination>` - BTP destination for MCP server authentication
- `--mcp=<mcp-destination>` - MCP destination for ABAP system connection

**Behavior:**
- MCP server URL: From `--mcp-url` parameter
- Authorization for MCP: `Authorization: Bearer <token>` from BTP destination (via auth-broker)
- ABAP connection parameters: From `--mcp` destination (via auth-broker)
  - `x-sap-url`: From MCP destination service key
  - `x-sap-jwt-token`: From MCP destination (via auth-broker token)
  - `x-sap-client`: From MCP destination service key (if available)
- Both BTP and ABAP authentication via destinations

**Use Case:** Production deployment with both BTP and ABAP destinations configured

**Example:**
```bash
mcp-abap-adt-proxy --mcp-url=https://mcp-server.cfapps.eu10.hana.ondemand.com --btp=btp-cloud --mcp=abap-system
```

### Scenario 4: MCP URL Only (No Destinations)

**Configuration:**
- `--mcp-url=<mcp-server-url>` - Direct URL to MCP server
- No `--btp` or `--mcp` parameters

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

**Request Headers (passed as-is to MCP server):**
```
x-sap-url: <abap-system-url>
x-sap-jwt-token: <token-for-abap>
x-sap-client: 100
# Any other headers are passed directly
```

## Header Mapping

### Validated Headers (Only Two)

| Header | Source | Description |
|--------|--------|-------------|
| `x-btp-destination` | Request header or `--btp` parameter | BTP destination name for MCP server authentication |
| `x-mcp-destination` | Request header or `--mcp` parameter | MCP destination name for ABAP system connection |

**Note:** These are the ONLY headers that proxy validates. All other headers are passed directly to MCP server.

### Headers Added by Proxy

| Source | Target Header | Description |
|--------|---------------|-------------|
| BTP destination token (via auth-broker) | `Authorization: Bearer <token>` | For MCP server on BTP (when `x-btp-destination` or `--btp` is provided) |
| MCP destination service key (via auth-broker) | `x-sap-url` | ABAP system URL (when `x-mcp-destination` or `--mcp` is provided) |
| MCP destination token (via auth-broker) | `x-sap-jwt-token` | ABAP authentication token (when `x-mcp-destination` or `--mcp` is provided) |
| MCP destination service key (via auth-broker) | `x-sap-client` | SAP client number (when `x-mcp-destination` or `--mcp` is provided) |

### Headers Passed Through

All headers from the original request (except `x-btp-destination` and `x-mcp-destination`) are passed directly to MCP server without modification:
- `x-sap-url` (if not from destination)
- `x-sap-jwt-token` (if not from destination)
- `x-sap-client` (if not from destination)
- `x-sap-auth-type`
- `x-sap-login`
- `x-sap-password`
- Any other custom headers

## Current Implementation Analysis

### ✅ What Works Correctly

1. **BTP destination handling**: Correctly gets token from BTP destination for MCP server authorization
2. **MCP destination handling**: Correctly gets ABAP configuration from MCP destination
3. **Command-line overrides**: `--btp`, `--mcp`, `--mcp-url` work as expected
4. **Header preservation**: Original SAP headers are preserved

### ❌ What Needs Fixing

1. **Header validation**:
   - Current: Validates all headers
   - Expected: Should validate only `x-btp-destination` and `x-mcp-destination`. All other headers should be passed through.

2. **No .env file usage**:
   - Current: May use .env files through auth-broker
   - Expected: Should NOT use .env files for connection configuration, only destinations via auth-broker (service key files)

## Implementation Requirements

### Priority 1: Simplify Header Validation

1. **Validate only two headers**:
   - `x-btp-destination` (or `--btp` parameter)
   - `x-mcp-destination` (or `--mcp` parameter)
   - All other headers should be passed directly to MCP server

2. **Header passthrough**:
   - When destinations are not provided, all headers from request are passed as-is
   - No validation or modification of other headers

### Priority 2: Remove .env File Support

1. **Ensure no .env file usage**:
   - Remove `dotenv` from dependencies (not used in code)
   - Verify auth-broker uses only service key files (destinations)
   - Document that .env files are not supported for connection configuration in proxy
   - Note: Session stores may use .env files for token storage, but connection config comes only from service keys

## Testing Scenarios

### Test 1: Local MCP with Headers Only
```bash
# Start proxy
mcp-abap-adt-proxy --mcp-url=http://localhost:3000

# Send request with headers
curl -X POST http://localhost:3001/mcp/stream/http \
  -H "x-sap-token: <mcp-token>" \
  -H "x-sap-url: <abap-url>" \
  -H "x-sap-jwt-token: <abap-token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

**Expected:**
- MCP server receives: `Authorization: Bearer <mcp-token>`
- MCP server receives: `x-sap-url`, `x-sap-jwt-token` headers

### Test 2: BTP MCP with BTP Destination
```bash
# Start proxy
mcp-abap-adt-proxy --mcp-url=https://mcp-server.cfapps.eu10.hana.ondemand.com --btp=btp-cloud

# Send request
curl -X POST http://localhost:3001/mcp/stream/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

**Expected:**
- MCP server receives: `Authorization: Bearer <btp-token>` (from BTP destination)
- No ABAP headers (unless provided in request)

### Test 3: BTP MCP with Both Destinations
```bash
# Start proxy
mcp-abap-adt-proxy --mcp-url=https://mcp-server.cfapps.eu10.hana.ondemand.com --btp=btp-cloud --mcp=abap-system

# Send request
curl -X POST http://localhost:3001/mcp/stream/http \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

**Expected:**
- MCP server receives: `Authorization: Bearer <btp-token>` (from BTP destination)
- MCP server receives: `x-sap-url`, `x-sap-jwt-token` (from MCP destination)

### Test 4: BTP MCP with Headers Override
```bash
# Start proxy
mcp-abap-adt-proxy --mcp-url=https://mcp-server.cfapps.eu10.hana.ondemand.com --btp=btp-cloud

# Send request with ABAP headers
curl -X POST http://localhost:3001/mcp/stream/http \
  -H "x-sap-url: <custom-abap-url>" \
  -H "x-sap-jwt-token: <custom-abap-token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

**Expected:**
- MCP server receives: `Authorization: Bearer <btp-token>` (from BTP destination)
- MCP server receives: `x-sap-url`, `x-sap-jwt-token` (from request headers, overriding destination if `--mcp` not provided)

## Summary

The proxy should support flexible routing:
- **Local MCP**: Use `--mcp-url` + request headers for all parameters
- **BTP MCP**: Use `--mcp-url` + `--btp` for MCP auth, optionally `--mcp` for ABAP config
- **Header priority**: When destinations are not provided, use request headers
- **No .env files**: Only use destinations via auth-broker, never .env files


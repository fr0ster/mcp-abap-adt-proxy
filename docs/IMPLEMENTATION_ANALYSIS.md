# Implementation Analysis

## Current Implementation vs Requirements

### ✅ What Works Correctly

1. **BTP Destination Handling**
   - ✅ Correctly gets token from BTP destination for MCP server authorization
   - ✅ Uses `Authorization: Bearer <token>` header
   - ✅ Integrates with auth-broker properly

2. **MCP Destination Handling**
   - ✅ Correctly gets ABAP configuration from MCP destination
   - ✅ Extracts `x-sap-url`, `x-sap-jwt-token` from destination
   - ✅ Handles token refresh

3. **Command-Line Overrides**
   - ✅ `--btp` parameter works correctly
   - ✅ `--mcp` parameter works correctly
   - ✅ `--mcp-url` parameter works correctly
   - ✅ Overrides take precedence over headers

4. **Header Preservation**
   - ✅ Original SAP headers are preserved (`x-sap-client`, `x-sap-auth-type`, etc.)

5. **URL Resolution**
   - ✅ Correctly resolves MCP server URL from `--mcp-url`
   - ✅ Falls back to service key URLs when needed

### ❌ What Needs Fixing

#### Issue 1: Header Validation Simplification

**Current Behavior:**
- Validates all headers using `validateAuthHeaders()` from header-validator
- May reject requests with unexpected headers

**Required Behavior:**
- Should validate only two headers: `x-btp-destination` and `x-mcp-destination`
- All other headers should be passed directly to MCP server without validation

**Location:** `src/router/headerAnalyzer.ts` - `analyzeHeaders()` function

**Fix Required:**
- Remove or simplify `validateAuthHeaders()` call (only validate destinations)
- Ensure all other headers are passed through

#### Issue 2: .env File Usage

**Current Behavior:**
- `dotenv` package is in devDependencies but not used in code
- auth-broker may use `.env` files for session storage (this is OK)
- Connection configuration should come only from service key files

**Required Behavior:**
- Remove `dotenv` from dependencies (not needed)
- Ensure connection configuration uses only service key files (destinations)
- Document that `.env` files are not used for connection configuration

**Location:** `package.json`, `src/lib/stores.ts`

**Fix Required:**
- Remove `dotenv` from devDependencies
- Verify that stores use only service key files for connection configuration
- Document that session stores may use `.env` for token storage, but connection config comes from service keys

## Implementation Priority

### Priority 1: Simplify Header Validation (High)
- Validate only `x-btp-destination` and `x-mcp-destination` headers
- Pass all other headers directly to MCP server
- **Impact**: Simpler logic, more flexible header handling
- **Effort**: Low (simplify validation logic)

### Priority 2: Remove .env Dependencies (Low)
- Remove `dotenv` from devDependencies
- Document that `.env` files are not used for connection configuration
- **Impact**: Cleaner dependencies, clearer documentation
- **Effort**: Low (remove dependency, update docs)

## Testing Requirements

After implementing fixes, test all scenarios from [Routing Logic Specification](./ROUTING_LOGIC.md):

1. ✅ Local MCP with headers only
2. ✅ BTP MCP with BTP destination
3. ✅ BTP MCP with both destinations
4. ✅ BTP MCP with header overrides
5. ✅ Error cases (missing headers, invalid destinations)

## Code Locations

### Files to Modify

1. **`src/proxy/cloudLlmHubProxy.ts`**
   - `buildProxyRequest()` method
   - Add header-based authentication logic
   - Add header-based ABAP parameter logic

2. **`src/router/headerAnalyzer.ts`**
   - `analyzeHeaders()` function
   - Update validation logic for header-only mode

3. **`src/lib/stores.ts`**
   - Verify no `.env` file usage
   - Document destination-only approach

4. **Documentation**
   - Update README.md with new routing scenarios
   - Update USAGE.md with examples
   - Update CONFIGURATION.md with header-based options

## Summary

The current implementation works well for destination-based routing but lacks support for header-based routing. The main gaps are:

1. **Header-based MCP authentication** - Missing `x-sap-token` support
2. **Header-based ABAP parameters** - Missing header extraction when `--mcp` is not provided
3. **Routing validation** - Too strict, doesn't allow header-only mode
4. **.env file prevention** - Needs explicit configuration

All fixes are straightforward and can be implemented incrementally.


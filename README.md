# @mcp-abap-adt/proxy

MCP proxy server for SAP ABAP ADT - proxies local requests to cloud-llm-hub with JWT authentication.

## Overview

This package acts as a proxy between local MCP clients (like Cline) and the cloud-based MCP server (`cloud-llm-hub`). It intercepts MCP requests, analyzes authentication headers, and routes them appropriately:

- **Direct cloud requests** (`x-sap-destination: "S4HANA_E19"`) - forwarded directly to cloud
- **Basic auth requests** (`x-sap-auth-type: "basic"`) - handled locally (no cloud connection needed)
- **Service key requests** (`x-sap-destination: "sk"`) - proxied to cloud-llm-hub with JWT token from auth-broker

## Purpose

Enable local MCP clients to connect to cloud ABAP systems through `cloud-llm-hub` with automatic JWT token management via `@mcp-abap-adt/auth-broker`.

## Status

🚧 **In Development** - See [ROADMAP.md](./ROADMAP.md) for development plan.

## License

MIT


# Migration to 4.0

Two things changed that a consumer can see, and one that only a programmatic
consumer can. Everything else in this release is internal.

If you run the proxy from a config file and point a client at it, **read §1 and
stop there** — that is very likely all that applies to you.

## 1. Dependencies: the contracts moved out of the umbrella

`@mcp-abap-adt/interfaces` is gone from this package's dependencies. The
contracts now come from the packages they live in:

```
@mcp-abap-adt/interfaces           ^7.0.0 → removed
@mcp-abap-adt/interfaces-network     (new) → ^2.0.0   every HTTP header constant
@mcp-abap-adt/interfaces-auth        (new) → ^1.2.0   ITokenRefresher
@mcp-abap-adt/interfaces-auth-sap    (new) → ^1.0.0   IAuthorizationConfig
@mcp-abap-adt/connection             (new) → ^9.2.0   TokenAuthProvider
```

The sibling packages moved with them — `auth-broker` to `^2.2.0` (a major),
`auth-providers` `^2.2.2`, `auth-stores` `^1.2.0`, `header-validator` `^0.3.0`,
`logger` `^0.4.0` — because each has left the umbrella too. Nothing in this
package's tree asks for `@mcp-abap-adt/interfaces` any more.

**What you do:** if you install this package and nothing else, nothing. If your
own code imported a contract type and happened to resolve it through this
package's tree, install the package that now declares it. The old name still
exists on npm and still re-exports everything, but every one of those exports is
marked `@deprecated`.

## 2. An SSE response streams, and carries your headers

This only matters if you use `transport: sse`. The `streamable-http` and `stdio`
transports are unaffected.

The SSE transport used to rebuild each request by hand, carry it over axios,
buffer the whole answer and rewrap it as a JSON-RPC envelope. It now goes through
the same transparent pipe as every other transport. Three consequences:

**The response arrives as it is produced**, not all at once at the end. This is
the point of the change.

**Your headers reach the target.** The old path forwarded none of them and
imposed two of its own:

```
Accept:       application/json, application/x-ndjson, text/event-stream
Content-Type: application/json
```

It no longer does. The proxy is transparent and answers for the `Authorization`
header only. If your target requires a particular `Accept`, put it in that
proxy's `defaultHeaders`, where it is your choice and visible in your config:

```yaml
defaultHeaders:
  accept: "application/json, text/event-stream"
```

A header your client sends always wins over `defaultHeaders`.

**The upstream path is your client's path.** The old SSE path had three branches:
with `targetUrl` set it used base + your client's path; with a service-key URL
already containing `/mcp` it used that URL as-is and *discarded* your client's
path; otherwise it appended `/mcp/stream/http`. Now it is always base + your
client's path.

**What you do:** if your config sets `targetUrl`, nothing — that is the branch
the old code took and it behaved the same way. If it relies on the service key's
own `abap.url`, set `targetUrl` explicitly to the URL you actually want.

## 3. `BtpProxy.getJwtToken()` is replaced, not renamed

Only for code that imports `BtpProxy` directly.

```ts
// before
const token = await proxy.getJwtToken(destination);
forward(req, res, url, token);          // composed `Bearer ${token}` itself

// after
const authorization = await proxy.getAuthorizationHeader(destination);
forward(req, res, url, authorization);  // a complete header VALUE, or null
```

`getAuthorizationHeader()` answers the whole header value — `Bearer <token>` — or
`null` where the credential is not a header at all, which a certificate is not.
Pass it through as it stands: composing `Bearer` around it sends
`Bearer Bearer <token>`, and turning `null` into `''` sends an empty
`Authorization`, which is a different claim from having none.

Gone with it: `proxyRequest()`, `buildProxyRequest()`, and the `ProxyRequest` /
`ProxyResponse` types. They described the envelope the axios path built; there is
no envelope any more.

## 4. The circuit breaker is gone

It guarded the buffered forward. The forwarding path streams, and a breaker there
would mean buffering the response again — the thing being fixed. A target that
keeps failing now fails visibly on every request instead of being
short-circuited.

`circuitBreakerThreshold`, `circuitBreakerTimeout` and
`MCP_PROXY_CIRCUIT_BREAKER_*` are still read, so existing configuration loads
unchanged. They do nothing.

Retry is unaffected and still applies to getting a token: 5xx and network
failures are retried with exponential backoff. A missing service key is not
retried — it answers at once, naming the file to create.

## What did not change

The routing rules, `x-sap-destination` / `--btp`, `x-target-url` /
`--target-url`, `defaultHeaders`, `${VAR}` interpolation, `envFile`, the service
key layout, the transports on offer, and every configuration key except the two
named above.

## New, and entirely optional

A second command, `mcp-abap-adt-proxy-mcp`, speaks MCP over stdio and its tools
start and stop proxies from the configs in `~/.config/mcp-abap-adt/proxy/`.
Nothing about the existing command changes because it exists — see
[Usage](./USAGE.md#the-management-mode).

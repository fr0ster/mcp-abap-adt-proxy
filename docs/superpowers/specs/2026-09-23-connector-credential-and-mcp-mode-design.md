# Design: the shared credential, and an MCP mode that runs the proxy

Date: 2026-09-23
Status: **implemented.** Part 0 published as `@mcp-abap-adt/connection@9.0.0`;
Parts 1 and 2 are on `chore/dep-refresh` (PR #37), reviewed once, with the
findings and their resolutions in §9. Two verifications remain open and are
tracked in `ROADMAP.md`, not here.

Corrected in place wherever this document turned out to be wrong, rather than
left as the version that was believed at the time — §9 lists those too.

Two independent pieces of work, written up together because they were
brainstormed together and because one of them is gated on a release in another
repository. They do not depend on each other: Part 2 can start today, Part 1
cannot start until Part 0 is published.

---

## 1. Context

`@mcp-abap-adt/proxy` is an authorization proxy. A local MCP client that cannot
authenticate on its own points at the proxy; the proxy obtains a JWT for a BTP
destination and forwards the request to the target service. It does not talk
ADT and it is not supposed to.

Two things are wrong with the current state, and one thing is missing.

**Wrong, first:** the proxy carries its own token machinery. `src/proxy/btpProxy.ts`
is 1248 lines, and a large share of it re-implements what
`@mcp-abap-adt/auth-broker` already does — a token cache with its own TTL, JWT
`exp` decoding, a proactive-refresh timer per destination. The broker caches,
knows expiry, and refreshes. The duplicate layer is not only redundant, it
**holds resources nobody asked for**: a `setTimeout` per destination, alive for
as long as the process is.

**Wrong, second:** the proxy has two forwarding paths that disagree about what a
transparent proxy is. The main one (`src/index.ts:399` → `forwardRequest`) is a
raw `node:http` pipe — correct. The other (`src/index.ts:663` →
`BtpProxy.proxyRequest`, fed by ~300 lines of `buildProxyRequest`) buffers
through axios and rebuilds the request by hand. It exists only for the SSE
transport.

**Missing:** there is no way for an LLM client to run the proxy. Today a human
starts it in a terminal, and if two sessions each want one, they collide on port
3001 and on the OAuth callback port.

### Decisions taken during brainstorming

| Question | Decision |
|---|---|
| What "migrate to the adt-client connector" means here | Take the credential contract from `@mcp-abap-adt/connection`; do **not** route traffic through `makeAdtRequest` |
| How deep the connector goes into the forward path | Credential and base URL only. The pipe stays a pipe |
| Is the proxy transparent | Yes. Unchanged, and it constrains everything below |
| Which `interfaces` version | The latest (`^50`), which makes Part 0 a prerequisite |
| What `start` starts | A listener **in the MCP server's own process** |
| What happens on a port conflict | Take a free port. And, more importantly, hold nothing that is not needed |
| The axios SSE path | Collapse it into `forwardRequest` now |

### Why the credential rather than the connector object

The brainstorming answer was "connector = authorization + base URL". On
inspection, `getBaseUrl()` is a plain field read (`AbstractAbapConnection.ts:890`)
— no `connect()`, no session. Constructing an `AdtCloudConnector` to obtain it
would mean building a session-capable object and deliberately never connecting
it, which reads as a session the proxy does not have.

So the unit the proxy actually takes is **`TokenAuthProvider`** — the credential.
That is the piece that replaces the hand-rolled token machinery, and it is the
piece that makes the proxy share the ecosystem's one authorization contract
rather than its own. The base URL comes from
`AuthBroker.getConnectionConfig(destination)`, which already returns it.

This is a deliberate narrowing of the brainstormed decision and the most likely
thing in this document to be overruled. If the proxy ever needs ADT session
semantics, `AdtCloudConnector` is the upgrade path and the same credential slots
into it unchanged.

### On "the single authorization system"

`auth-broker` **is** that system — it ships the `mcp-auth` and `mcp-sso`
binaries. The proxy already depends on it. This work does not replace it and
does not add a second way in. It stops the proxy from working *around* the
broker: the credential consumes the broker through `ITokenRefresher`, which the
broker already produces.

The bridge exists on both sides and is unused only here:

```
AuthBroker.createTokenRefresher(dest)     // auth-broker/src/AuthBroker.ts:931
    → { getToken(), refreshToken() }      //   i.e. ITokenRefresher
        ↓
new TokenAuthProvider(refresher)          // connection/src/auth/providers.ts:59
    → authorizationHeader(): Promise<string | null>
```

---

## 2. Part 0 — prerequisite: `connection` off the deprecated umbrella

**Repository: `mcp-abap-connection`. Not this one. Done, merged and published as
`@mcp-abap-adt/connection@9.0.0` — PR
[#52](https://github.com/fr0ster/mcp-abap-connection/pull/52).**

This section originally described Part 0 as fixing what eleven majors of
`@mcp-abap-adt/interfaces` had broken. That was the wrong diagnosis, and
measuring it said so: `connection` on `interfaces@50` built clean and passed all
40 suites without a single source change.

What actually happened is a **split**. The contracts moved into four packages,
and what remains at the old name is an umbrella of **376 re-exports, every one
marked `@deprecated`**:

| Package | Contracts |
|---|---|
| `@mcp-abap-adt/interfaces-adt@^6` | `IAbapConnection`, `IAbapRequestOptions`, `IAdtWireResponse`, `ISapConfig`, `ITokenRefresher`, `IAuthorizationConfig`, the capability atoms, `ADT_SESSION_ERROR`, and the `x-sap-*` header constants |
| `@mcp-abap-adt/interfaces-auth@^1.1` | `IAuthProvider`, `IRenewableCredential`, `ICertificateMaterial` |
| `@mcp-abap-adt/interfaces-network@^1` | `ITimeoutConfig`, `NETWORK_ERROR_CODES`, the WebSocket contracts, and the generic HTTP header constants |
| `@mcp-abap-adt/interfaces-utils@^1` | `ILogger` |

So the prerequisite is not repair work. It is getting `connection` off a shim
that is advertised as going away, which PR #52 does: 29 files now import from
the package each contract lives in, and the dependency on the umbrella is
removed entirely.

**The ordering is unchanged and still binding:**

1. PR #52 merges in `mcp-abap-connection`.
2. The **user publishes** it — a major, because removing the umbrella dependency
   breaks any consumer that was getting it transitively.
3. Only then does the proxy take a dependency on it.

Nothing here is npm-linked to an unpublished `connection`.

### The version argument, which applies here too

An earlier draft of this section said a re-export loses the identity of the type
behind it. That was wrong, and a review caught it: through the umbrella and
directly, `IAuthProvider` is the *same type* — verified with a deferred
conditional, which compares declarations rather than shapes.

The real hazard is versions. The umbrella carries its own ranges for the
contract packages, so a tree holding both the umbrella and a direct dependency
at a different major gets two physical copies — observed: `interfaces-adt@4` at
the root and `@6` nested under the umbrella. TypeScript is structural, so the
two are interchangeable wherever their shapes agree and a type error at the
package boundary wherever they do not, far from the skew that caused it.

For the proxy this means: follow `connection` onto the same contract packages,
so the version is one decision and `npm ls` can answer for it. Plus the plain
reason — the umbrella's every export is `@deprecated`.

## 3. Part 1 — the proxy takes the shared credential

### 3.1 What is deleted

All of it from `src/proxy/btpProxy.ts`:

| Removed | Lines | Why |
|---|---|---|
| `tokenCache`, `TOKEN_CACHE_TTL`, `decodeJwtExp()`, `cacheToken()` | 134–138, 574–601 | The broker caches and knows expiry |
| `refreshTimers`, `scheduleProactiveRefresh()`, `proactiveRefresh()` | 136, 603–646 | `authorizationHeader()` is asked per request and renews behind the call. These timers are held resources with no job |
| `axiosInstance` and both interceptors | 131, 175–230 | No axios path survives |
| `buildProxyRequest()` | 706–1010 | See §3.3 |
| `proxyRequest()` | 1016–1198 | See §3.3 |
| `src/proxy/cloudLlmHubProxy.ts` | whole file | Contains the single line `// DELETED` |

### 3.2 What is added

**`src/proxy/credentials.ts`** (new, small) — one job: given a destination,
produce the credential and the base URL, and cache both per destination the way
brokers are cached today.

```ts
interface DestinationAccess {
  credential: TokenAuthProvider;   // from @mcp-abap-adt/connection
  baseUrl: string;                 // from broker.getConnectionConfig(dest)
}
```

`BtpProxy` becomes a thin facade over it:

- `getAuthorizationHeader(dest)` → `credential.authorizationHeader()`
- `getTargetUrl(dest)` → the cached `baseUrl`, with `x-target-url` / `--target-url`
  layered on top exactly as now

`getJwtToken()` is replaced rather than kept: `authorizationHeader()` returns the
complete header value (`"Bearer <token>"`), not a bare token. `forwardRequest()`
changes its fourth parameter from `jwtToken: string` to
`authorization: string | null` and stops composing `Bearer ${...}` itself. A
`null` credential contributes no header — that is legitimate in the contract and
must not be turned into an empty `Authorization`.

`ensureSessionServiceUrl()` (line 361) is kept. It reconciles a
`--target-url` override against the stored connection config and has no
equivalent in the credential.

### 3.3 The SSE path is collapsed into the pipe

`src/index.ts:663` stops calling `BtpProxy.proxyRequest` and calls
`forwardRequest` instead — the same transparent pipe the main path uses.
`buildProxyRequest` and `proxyRequest` are then dead and go with it.

This is the one change in Part 1 that touches observable behaviour, because SSE
responses stop being buffered and start streaming. It must be checked against a
live MCP client over the SSE transport, not only against unit tests. If that
check fails, the fallback is to keep the axios path fed by the credential and
raise collapsing it as its own task — but the intent is to remove it.

`src/proxy/reverseProxy.ts` is otherwise untouched. The proxy is transparent;
the pipe stays a pipe.

### 3.4 Dependencies

The contracts moved twice while this was being implemented, and the second move
dropped a package this section had just added. What shipped:

```
@mcp-abap-adt/interfaces           ^7.0.0 → removed
@mcp-abap-adt/interfaces-network     (new) → ^2.0.0   every HTTP header constant
@mcp-abap-adt/interfaces-auth        (new) → ^1.2.0   ITokenRefresher
@mcp-abap-adt/interfaces-auth-sap    (new) → ^1.0.0   IAuthorizationConfig
@mcp-abap-adt/connection             (new) → ^9.2.0   TokenAuthProvider
@mcp-abap-adt/auth-broker          ^1.0.8 → ^2.1.0   (a major)
@mcp-abap-adt/auth-providers       ^2.0.0 → ^2.2.1
@mcp-abap-adt/auth-stores          ^1.0.4 → ^1.2.0
@mcp-abap-adt/logger               ^0.1.4 → ^0.4.0
```

`interfaces-adt` was taken at `^6` and then dropped: after the second move
nothing here imports anything from it, because every `HEADER_*` constant went to
`interfaces-network`.

This section originally said the auth siblings were out of scope. They were, and
then they raised themselves onto the split packages, so taking them collected
that work — and copies of the deprecated umbrella in the tree went 6 → 2. The two
that remain are declared by `auth-broker` and `header-validator` themselves.

The proxy follows `connection` off the umbrella for the identity reason in §2.
Every symbol it imports today has a confirmed home in the split — verified
against the installed packages, not assumed:

| Symbol | Now in |
|---|---|
| `HEADER_BTP_DESTINATION`, `HEADER_SAP_DESTINATION`, `HEADER_SAP_DESTINATION_SERVICE`, `HEADER_SAP_CLIENT`, `IAuthorizationConfig` | `interfaces-adt` |
| `HEADER_AUTHORIZATION`, `HEADER_ACCEPT`, `HEADER_CONTENT_TYPE` | `interfaces-network` |

`interfaces-auth` is not listed as a direct dependency because the proxy names
no symbol from it: `TokenAuthProvider` comes from `connection`, and the proxy
holds it by that class rather than by the `IAuthProvider` contract. Add it the
moment a signature in this repo says `IAuthProvider`.

---

## 4. Part 2 — the MCP mode

Independent of Parts 0 and 1. Can start immediately.

### 4.1 Shape

A second binary in this package: **`mcp-abap-adt-proxy-mcp`**. It speaks MCP over
**stdio** and exposes tools that start and stop the proxy.

The listener runs **in that same process**. This is not a convenience; it is the
rule the existing launcher already states in `bin/mcp-abap-adt-proxy.js:159` —
a spawned child is orphaned by any signal the launcher does not forward and keeps
holding the HTTP and OAuth callback ports. In-process, the listener dies when the
stdio session dies, and the ports go with it. A supervisor spawning detached
children would reintroduce exactly the failure that comment was written to close.

```
Claude Code / Cline
   │ stdio (MCP)
   ▼
mcp-abap-adt-proxy-mcp          ← one process
   ├── MCP server  (tools: proxy_start / proxy_stop / proxy_status)
   ├── supervisor  (owns listeners started in this process)
   └── registry    (file-backed view of every live instance, incl. other sessions)
         ▼
   HTTP listener on a free port  ← started and stopped on demand
```

### 4.2 New files

| File | Job |
|---|---|
| `src/mcp/server.ts` | stdio MCP server; registers the three tools |
| `src/mcp/supervisor.ts` | `start(cfg) → {instanceId, url, port}`, `stop(instanceId)`, `list()`. Owns only what this process started |
| `src/mcp/registry.ts` | Live-instance records on disk; prunes dead ones |
| `src/mcp/ports.ts` | `listen(0)` and report the port actually bound |
| `bin/mcp-abap-adt-proxy-mcp.js` | Entry point, mirroring the in-process rule of the existing one |

### 4.3 The tools

| Tool | Input | Output |
|---|---|---|
| `proxy_start` | `destination`, `targetUrl?`, `headers?`, `idleTimeoutMs?` | `instanceId`, `url`, `port`, and a reminder to stop it |
| `proxy_stop` | `instanceId?` (absent = every instance this process owns) | what was stopped |
| `proxy_status` | — | this process's instances, plus other live instances from the registry |

`proxy_stop` never touches an instance this process does not own. Another
session's proxy is reported by `proxy_status` so the agent can see it, and left
alone.

### 4.4 Telling the client to clean up after itself

A stated requirement: the tool description must tell the LLM client that having
started the proxy, it must put it out.

Said in three places, because a model reads descriptions selectively:

1. In `proxy_start`'s `description` — that the proxy holds a port and live
   credentials for as long as it runs, and that `proxy_stop` is expected when the
   work is done.
2. In `proxy_start`'s **result text**, next to the URL — the place most likely to
   be in context when the task finishes.
3. In the MCP server's own instructions.

### 4.5 Holding nothing that is not needed

This is the requirement that shapes Part 2, not a line item in it.

- **HTTP port:** `listen(0)`. Never a fixed 3001, so two sessions never collide.
  The bound port is reported back, never assumed.
- **OAuth callback port:** nothing to do here, and this section was wrong to
  claim otherwise. It said the port would be "taken free" and released by the
  stop. In fact `auth-providers` has owned that socket since 1.2.0 and releases
  it unconditionally on whatever ends the login — the code arriving, a failure,
  the timeout, cancellation — so a settled login always means the port is free.
  The proxy neither picks it nor holds it; a config names it, and two logins
  cannot overlap on one port, which `docs/CONFIGURATION.md` already documented.
  What WAS wrong is that the login fired lazily on the first forwarded request;
  `proxy_start` now proves the credential before reporting success.
- **On `stop`:** close the server, dispose the broker, drop cached credentials,
  remove the registry record. In that order.
- **On stdio close, `SIGTERM`, `SIGINT`:** stop everything this process owns.
- **Idle timeout:** `idleTimeoutMs`, default 30 minutes with no forwarded
  request, then stop the instance and log the reason. This is the backstop for
  the case §4.4 is trying to prevent — an agent that finished and forgot.

Note that Part 1 serves this requirement too: deleting `refreshTimers` removes a
per-destination timer that currently outlives any use of the destination.

### 4.6 The registry

Files under `~/.config/mcp-abap-adt/runtime/<pid>-<port>.json`, following the
platform convention already in `src/lib/stores.ts` (Windows:
`%USERPROFILE%\Documents\mcp-abap-adt\runtime\`).

Each record: `pid`, `port`, `url`, `destination`, `startedAt`.

A record is a claim, not a fact. Every read prunes: if `process.kill(pid, 0)`
throws `ESRCH`, the writer is gone and the file goes with it. A crashed session
therefore cannot leave a permanent ghost, and nothing in the system trusts a
record without checking the process behind it.

---

## 5. Testing

Unit tests, in `src/__tests__/`, following the existing layout.

**Part 1**
- The credential cache returns one credential per destination and does not
  rebuild it per request.
- `authorizationHeader()` returning `null` produces **no** `Authorization`
  header, not an empty one.
- `getTargetUrl` precedence is unchanged: `x-target-url` header, then
  `--target-url`, then the connection config's URL.
- No timer survives `dispose()`.

**Part 2**
- `ports`: two consecutive `start` calls bind two different ports.
- `registry`: a record whose pid is dead is pruned on read; a record whose pid is
  alive is not.
- `supervisor`: `stop` frees the port — asserted by binding it again afterwards,
  not by trusting the return value.
- `supervisor`: stdio close stops every owned instance.
- Tool descriptions and `proxy_start`'s result text both carry the shutdown
  reminder. This is asserted, because it is a stated requirement and prose is
  exactly the kind of thing that gets edited away.

**Not unit-testable, must be done by hand**
- §3.3: SSE against a live MCP client, after the axios path is removed.

---

## 6. Out of scope

- Routing traffic through `makeAdtRequest`, ADT sessions, or CSRF. The proxy is
  transparent and stays transparent.
- Giving the proxy its own `AdtClient`. It does not talk ADT.
- Raising `auth-broker`, `auth-providers`, `auth-stores` or `header-validator`
  onto `interfaces@50`.
- Sharing one proxy between MCP client sessions. Each session runs its own on its
  own port.
- Publishing anything. The user publishes; see §2.

---

## 7. Risks

| Risk | Handling |
|---|---|
| ~~Eleven majors of `interfaces` break `connection`~~ | **Retired.** Measured: `connection` on `interfaces@50` built clean, 40/40 suites. The real work was the umbrella split, and PR #52 has done it |
| Symbols the proxy imports were renamed or moved | Enumerated in §3.4 with the package each one is now in, checked against the installed packages |
| Removing the axios SSE path changes SSE behaviour | §3.3 names the live check and the fallback |
| An idle timeout stops a proxy an agent was still using | The default is 30 minutes of **no forwarded request**, it is configurable per `proxy_start`, and the stop is logged with its reason |

---

## 8. Documentation owed (not optional)

Per the repository's release rule, the changelog is not the documentation. This
work changes the contract, so it updates:

- `README.md` — the new `mcp-abap-adt-proxy-mcp` command
- `docs/CONFIGURATION.md` — `idleTimeoutMs`; free-port behaviour
- `docs/ARCHITECTURE.md`, `docs/ROUTING_LOGIC.md` — one forwarding path, not two
- `docs/USAGE.md`, `docs/CLIENT_SETUP.md` — how an MCP client registers the MCP mode
- `CLAUDE.md` — already stale today: it describes `src/proxy/cloudLlmHubProxy.ts`
  as the proxy implementation (the file contains `// DELETED`) and points at
  `src/__tests__/proxy/cloudLlmHubProxy.test.ts`, which does not exist
- `ROADMAP.md` — a phase for the MCP mode
- A migration note for the breaking release

---

## 9. What the review found, and what this document got wrong

Reviewed once against `ad2e717..c5fc589`. Two Critical, eight Important, and a
handful of Minor. Everything below was reproduced before it was fixed, and two
findings were pushed back on with evidence rather than implemented.

### Critical

- **`stop()` never returned while a response was streaming.** `server.close()`
  waits for ACTIVE connections and a stream never becomes inactive — measured,
  the close callback had not fired after 1500ms. `proxy_stop` hung, the idle
  backstop hung, and SIGINT/SIGTERM/stdin-close hung with the port still held:
  the orphaned-port failure §4.1 says running in-process prevents, reached from
  the other end. Idle sockets now go at once, anything in flight gets
  `stopGraceMs`, then goes.
- **An idle timer could end the process.** `void this.stop(id)` floated a promise
  that can reject, and an unhandled rejection from a timer is fatal — thirty
  minutes later, taking the client's session with a proxy that had merely sat
  unused.

### Important

- The baseline config was **erased, not fallen back on**: `applyDefaults` sets
  every key, so spreading a loaded config over a baseline wrote
  `defaultHeaders: undefined` over the documented home of `x-sap-login` /
  `x-sap-password`. The merge is gone; `loadConfig` already overlays CLI flags.
- **Retry around token acquisition had been deleted without mention.** In the
  standalone proxy an auth failure is fatal, so a transient UAA 503 went from
  "retried" to "kills the proxy". Restored and scoped.
- The **circuit breaker** was constructed and never consulted. Removed
  deliberately and announced; its config keys are still accepted and inert.
- The **service key error message** had been lost, so the commonest failure told
  the user to create a `.env` file this proxy never reads.
- `npm run test:check` was **red, and two of its three errors were mine** — type
  imports of `ProxyRequest`/`ProxyResponse` that M2 deleted, which `npm test`
  hid because ts-jest elides type-only imports. I had reported all three as
  pre-existing. Now zero.
- `src/mcp/server.ts` had **no tests**; the shutdown path is now its own tested
  unit (`src/mcp/shutdown.ts`) with a deadline, so nothing hanging below can
  stop the process leaving.
- The **documentation §8 owed was half delivered**, and the dependency commits
  then made more of it wrong. Seven files still described a circuit breaker.
  `docs/MIGRATION-4.0.md` now exists.

### Pushed back on, with evidence

- **"Nothing can release the OAuth callback port."** Not so — see §4.5 as
  corrected. The real defect nearby was the lazy login, which is fixed.
- **"The SSE change is riskier than stated."** Partly. Measured against the
  configs in use: all eight declare `transport: streamable-http` and all eight
  set `targetUrl`, so the SSE branch is unused and the old code's `targetUrl`
  branch did what the new one does. What remained real was the `Accept` header,
  and that was settled by a rule rather than a patch: **the proxy is transparent
  and answers for the authorization header only.** It is recorded in `CLAUDE.md`
  because the code and this document had drifted apart on it.

### Minor, all fixed

An open stream counted as idle — which stopped working sessions, so it was the
most consequential thing on the Minor list. A pid outlives its boot, so records
now carry `bootedAt`. Records are written and renamed rather than truncated in
place. `others()` no longer calls our own orphan another session's. A dangling
symlink no longer costs the whole config listing. `AUTH_BROKER_PATH` survives a
Windows drive letter, and a value pointing at one of the four folders takes the
parent.

### Still open, and tracked in `ROADMAP.md`

- `proxy_start` end to end against a live BTP destination.
- The SSE streaming change against a live MCP client.

Neither is verifiable here: the first needs a real service key, the second a real
client. They are the reason this document is not simply deleted yet.

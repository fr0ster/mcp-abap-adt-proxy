# Orphaned server process and the OAuth callback port

Date: 2026-07-26
Status: approved, not yet implemented

## Problem

Starting a proxy fails with:

```
Token provider error for <destination>: Port 7777 is already in use.
Please specify a different port or free the port.
```

The port named is `browserAuthPort` — the transient OAuth2 callback port, which should
only be bound for the duration of an interactive browser login. In practice every proxy
config on this machine had to be given a distinct `browserAuthPort` (7777, 7778, 7779,
7780, 7782, 7786, 7799) to avoid collisions.

## Evidence

All figures below were measured, not inferred from code.

**The successful login path does release the port.** Real installed binary
(`@mcp-abap-adt/proxy@1.6.2`), fake UAA, two proxies started in sequence on the same
`browserAuthPort: 7805`:

```
proxy #1 bound 7805:                       true
sent /callback?code=...                    HTTP 200
7805 released:                             71 ms after callback
proxy #2 on the same 7805:                 started, no "already in use"
```

Release was verified by actually binding the socket with `net.createServer().listen()`,
not by reading log lines.

**The real cause is process orphaning.** `bin/mcp-abap-adt-proxy.js` is a launcher that
spawns `dist/index.js` as a child and forwards **only SIGINT** (line 217):

```
before SIGTERM to the launcher:
  1455794 ppid 1455753  node bin/mcp-abap-adt-proxy.js --config cfg1.yaml
  1455801 ppid 1455794  node dist/index.js            --config cfg1.yaml

after SIGTERM to the launcher:
  launcher alive: false
  1455801 ppid 4312     node dist/index.js --config cfg1.yaml   <- re-parented to systemd --user
  7805 still bound: true   (+5 s: still true)
```

`kill`, `pkill`, a closing terminal (SIGHUP) and an MCP client stopping the server all
send SIGTERM. The launcher dies; the real server survives holding every socket it owns,
including the callback port. Only Ctrl+C (SIGINT) is forwarded and shuts down cleanly.

The orphan is easy to miss: in `ps` it appears as `dist/index.js`, not
`mcp-abap-adt-proxy`, and its parent is `systemd --user`, so it is no longer tied to the
terminal it was started from.

**The shutdown code already exists and is correct.** `src/index.ts:881-897` registers an
`onSignal` handler for SIGINT and SIGTERM whose stated job is to "release the OAuth
callback port, MCP server, and HTTP listener". It never runs on SIGTERM because the
signal never reaches that process.

**The launcher has no reason to spawn.** It uses the same `process.execPath`, an
unmodified `{ ...process.env }`, `stdio: ['inherit','inherit','inherit']`, the same cwd
and the same argv, with no node flags. Its only own logic is `--help` / `--version` — and
`dist/index.js` already handles `--help` itself (`src/index.ts:874`).

**Secondary defect in `@mcp-abap-adt/auth-providers@1.1.0`** (`dist/auth/browserAuth.js`).
`reject()` (lines 264-269) neither closes the listening socket nor calls `stopStdin()`;
each of the six call sites is expected to close the server itself, and the seventh —
`/callback` without a `code` parameter (lines 449-453) — does not. Measured:

| terminal state | port after |
|---|---|
| successful login | free immediately (`resolve` runs inside the `close` callback) |
| token exchange failed | bound at reject, free ~300 ms later |
| `/callback` without `code` | bound at +5 s, +20 s, +35 s, +45 s — never released while the process lives |

The 30-second timeout that would otherwise close the socket is cleared inside `reject`.

## Design

Three changes, in this order. Each stands alone. #1 removes the orphaning mechanism —
the only way a proxy that was stopped can still be holding its callback port. A port can
of course also be occupied by an unrelated program that listens on the same number; no
change here prevents that.

### 1. Remove the launcher's child process (this repository)

Replace the spawn with an in-process load. `package.json` has no `type` field
(CommonJS) and `main` is `dist/index.js`, so `require` works directly.

```js
if (!fs.existsSync(serverPath)) {
  process.stderr.write(`[MCP Proxy] ✗ Server not found at: ${serverPath}\n`);
  process.stderr.write(`[MCP Proxy]   Build the project with 'npm run build' first.\n`);
  process.exit(1);
}
require(serverPath);
```

Deleted along with the spawn: the `close` and `error` child handlers, the SIGINT
forwarder with its `setTimeout(500)` race, and the duplicated `fs.existsSync` check
(lines 150 and 167). `--help` and `--version` stay.

Consequences: signals reach the server directly, so the existing `onSignal` runs and
releases the callback port, the MCP server and the HTTP listener. No child means nothing
can be orphaned. One fewer node process per proxy.

Also add `process.on('SIGHUP', onSignal)` in `src/index.ts` so closing the terminal
shuts down cleanly instead of orphaning.

### 2. Single-owner callback server (`@mcp-abap-adt/auth-providers`)

Extract the callback server into a unit that owns the socket and releases it in one
place, so no exit path can leak it.

```ts
class CallbackServer {
  static async start(opts: { port: number; logger?: Logger }): Promise<CallbackServer>
  readonly port: number          // the port actually bound
  readonly redirectUri: string   // http://localhost:<port>/callback
  waitForCode(timeoutMs: number): Promise<string>   // rejects with CallbackError
  close(): Promise<void>         // idempotent; resolves after the socket is released
}
```

`port` is **required** — the unit holds no default, so an omitted port cannot silently
become something. Defaults stay at the layers that already publish them, and each
resolves its own before calling down:

- `btpProxy.ts:298` passes `this.config.browserAuthPort || 3333`.
- `AuthorizationCodeProviderConfig.redirectPort` stays `?: number` with its existing
  default of 3001 (`AuthorizationCodeProvider.js:34,92`). This is a **public exported
  type** (`AuthorizationCodeProvider.d.ts:15`) — making it required would be a semver-major
  break for external consumers, and changing 3001 to 3333 would silently move the port
  under anyone relying on the documented default. Neither is in scope here. The provider
  resolves `redirectPort ?? 3001` and passes a concrete number down.
- Only the parameter default inside `startBrowserAuth` (`port = 3001`) is removed, since
  the provider now always supplies a value. That function is `@internal` and is not
  re-exported from the package index — though note `package.json` declares no `exports`
  map, so deep imports remain technically reachable; treat it as internal by convention,
  not as unreachable.

`port: 0` is meaningful — bind an ephemeral port and report it via `this.port` — but no
caller passes it under this design. That is change #3, and it stays deferred; making the
parameter required is what keeps #3 an explicit call-site decision instead of something
that happens by omission.

```ts
const srv = await CallbackServer.start({ port: resolvedPort, logger });
let code: string;
try {
  const url = buildAuthorizationUrl(authConfig, srv.redirectUri);
  const waiting = srv.waitForCode(timeoutMs);        // timer armed before anything can block
  openBrowser(url, browser).catch((e) => srv.fail(new BrowserOpenError(url, e)));
  code = await waiting;
} finally {
  await srv.close();          // released before the exchange, not after
}
return await exchangeCodeForToken(authConfig, code, srv.redirectUri);
```

**Armed before `start()` resolves.** All three channels — the automatic `GET /callback`,
the web paste form (`GET /` and `GET /submit`), and the stdin reader gated on
`process.stdin.isTTY` — are registered, and the internal code promise created, before
`start()` resolves. A callback that arrives between `start()` and `waitForCode()` is
buffered, not lost. `waitForCode` only awaits an already-armed promise; it never installs
handlers. (The current code satisfies this by accident — routes are registered at lines
369/487/491, before `listen()` at line 522 — and the rewrite must keep it deliberate.)

**Single-settlement invariant.** The waiter settles exactly once. Whichever arrives first
— a valid code, an OAuth error callback, `fail()`, the timeout, or `close()` — wins, and
every later event is a no-op rather than a second settlement, a double close or an
unhandled rejection. Every branch that can end a login must go through the one function
that enforces this; none may settle the promise directly. This is the invariant the whole
design rests on, and the one an implementation is most likely to erode.

**The browser launch is never on the critical path.** `waitForCode` is called — and its
timer armed — before the launch is attempted, and the launch is never awaited inline. A
launcher that hangs (an `xdg-open` that blocks, a snap or flatpak wrapper that stays in
the foreground) therefore cannot delay anything: the timeout is already running, and a
code that arrives is delivered to a waiter that is already being awaited. A launch that
*fails* is routed into the same waiter through `srv.fail(err)`, which settles it exactly
as any other terminal event does, so browser-open failures still travel through the one
`finally`.

This adds two obligations to the contract:

- `fail(err: Error): void` — settle the armed waiter with `err`, idempotent, ignored if
  the waiter has already settled.
- `close()` must settle any still-pending waiter rather than leaving it dangling; a caller
  that closes without a code gets a rejection, never a promise that never resolves.

For `browser: 'none' | 'headless'` there is no launch at all — the URL is printed and the
same waiter is awaited, which is what those modes already do today.

**One timeout, owned by the server.** `waitForCode(timeoutMs)` holds the only login
timer. The external wrapper in `AuthorizationCodeProvider.js:103-114` —
`Promise.race([startBrowserAuth(...), timeoutPromise])` — must be deleted, not left
alongside it. Both timers are currently set to 30 seconds, so which one wins is down to
scheduling; when the external one wins, the provider's promise rejects while the callback
socket is still bound, defeating the guarantee that a settled promise means a free port.
A timeout must travel through the same `finally` as every other exit.

**Released before the token exchange.** `waitForCode` resolves as soon as any channel
yields a code; the socket is closed before `exchangeCodeForToken` runs, so a slow or hung
UAA cannot hold the port or block a parallel login for another destination. Ordering on
the HTTP path: flush the response to the browser, wait for `finish`, close the socket,
then exchange.

The lifecycle is the same on every channel: **the first valid code ends the attempt.**
There is no per-channel exception. Two consequences, both accepted:

- The browser page can no longer report the exchange result — it reports that the
  authorization completed. An exchange failure surfaces on the CLI only.
- The manual-paste retry loop is lost. Today `/submit` re-renders the form on a failed
  exchange and keeps waiting (lines 503-509); with the socket closed, a wrong or expired
  pasted code ends the attempt. Accepted because a failed startup login already exits the
  proxy for a clean retry (`fatalAuthFailure`, `src/index.ts:743`), and because a lifecycle
  that varies by channel is exactly the shape that produced the original leak.

**Terminal and non-terminal callbacks.** Three distinct cases, all specified:

| request | HTTP response | attempt |
|---|---|---|
| `?code=<value>` | success page | ends — `waitForCode` resolves |
| `?error=access_denied&error_description=…` | error page | ends — rejects with `CallbackError` |
| neither `code` nor `error` (malformed) | 400 | **continues** — keeps waiting until timeout |

The OAuth error case must reject immediately rather than degrading into a 30-second
timeout; the typed `CallbackError` carries `error`, `error_description` and `error_uri`.
The current code handles this (lines 375-445); the contract must state it.

A malformed callback is deliberately **not** terminal. A reloaded tab, a duplicate
request or a probe must not kill a login in progress. This is the exact request that
produces the current leak (lines 449-453), and the fix is not merely to release the port
on that path but to stop treating the request as fatal at all — matching how the paste
form already answers unusable input (lines 494-499): reject the input, keep waiting.

**`redirectUri` is a property of the server**, not a value derived from config, which
removes the port-mismatch case currently detected after the fact by a `warn` (line 292).

**`close()` contract.** Idempotent. Clears the login timeout and the `finish` fallback
timer, closes the stdin readline interface, and resolves only after the listening socket
is released — so an immediate retry cannot observe a phantom "already in use".

Order matters: call `server.close()` **first** to stop accepting, then
`closeAllConnections()` to destroy what is still open. The reverse order — which the
current code uses (lines 337-340) — leaves a window in which a new connection is accepted
after the destroy and then keeps `close()` waiting on it.

An idle keep-alive connection does not block the close, and the `keepAliveTimeout = 0`
line (line 205) is not what saves it. Measured on Node 25 with one live keep-alive socket
held open, `server.close()` completed in 0-3 ms at `keepAliveTimeout` of 0, 5000 and
72000 alike: since Node 19 `server.close()` closes idle connections itself. The full
`startBrowserAuth` flow settles and frees the port in ~10 ms with a keep-alive socket held
and new connections arriving concurrently.

So `closeAllConnections()` earns its place for connections with a request still in flight,
not for idle ones, and `keepAliveTimeout = 0` can be dropped as a no-op rather than as a
fix. Do not restate the old claim that it inverts its own comment — that was asserted from
the documentation and contradicted by measurement.

One limit worth stating: deleting `closeAllConnections` from the prototype on Node 25 to
imitate Node 18.0/18.1 still freed the port, but that only exercises Node 25's `close()`
semantics. It says nothing about how real Node 18.0/18.1 behaves, where `close()` predates
the idle-connection change. The `engines.node` raise to `>=18.2.0` stands on
`closeAllConnections` being called at all, not on this experiment.

`closeAllConnections()` landed in **Node 18.2.0**, while `engines.node` currently allows
`>=18.0.0`. Raise it to `>=18.2.0` as part of this change rather than writing a
socket-tracking fallback for two patch releases of an already end-of-life major.

### 3. Ephemeral port by default — deferred

`listen(0)` and report the bound port. Deferred until #1 and #2 have settled: with correct
signal handling and guaranteed release, collisions should no longer occur, and this
carries a real risk — if an XSUAA app registration restricts redirect URIs to an explicit
allowlist, an arbitrary port will be rejected. Revisit as a simplification, not a fix.

## Testing

- Launcher: spawn the binary, send SIGTERM, assert the process tree is empty and the
  callback port is bindable. Repeat for SIGHUP and SIGINT.
- Callback server: for each terminal state (success, `/callback?error=access_denied`,
  exchange failure, timeout, browser-open failure) assert the port is bindable after the
  promise settles. Bind the socket to check — do not assert on log output.
- Malformed callback: `GET /callback` with neither `code` nor `error` answers 400, the
  attempt stays alive, and a valid code delivered afterwards still resolves. The port is
  bindable once that attempt finally settles.
- Arming: deliver a callback in the same tick that `start()` resolves, before
  `waitForCode()` is called, and assert the code is still returned.
- Error callback: `?error=access_denied` rejects with a typed `CallbackError` carrying the
  OAuth fields, and does so immediately rather than after the login timeout.
- Keep-alive: a client holding an idle keep-alive connection must not delay `close()`.
- Hung browser launcher: stub `openBrowser` with a promise that never settles, deliver a
  valid callback, and assert the login completes and the port is bindable. Then repeat with
  no callback and assert the login still times out on schedule. Both fail if the launch is
  ever awaited on the critical path.
- Timeout ownership: drive a login past `timeoutMs` through `AuthorizationCodeProvider`
  and assert the port is bindable the moment the provider's promise rejects. This is the
  regression test for the removed `Promise.race` — with it in place the assertion fails
  roughly half the time, which is precisely why it must be asserted rather than reasoned
  about.
- Regression: two proxies started in sequence on one `browserAuthPort` must both work.

## Out of scope

Renumbering the existing configs. Once #1 lands, a stopped proxy stops holding its ports
and shared auth ports become workable; the current distinct-port scheme keeps working
either way.

## Release

#1 and the SIGHUP addition ship from this repository with no cross-package coordination.

#2 requires the `auth-providers` cycle: issue, branch, PR, unit tests, publish, then bump
the proxy — never link or import before publish. The `engines.node` raise to `>=18.2.0`
belongs to that release; align this repository's `engines.node` in the same commit that
bumps the dependency, so the two never disagree about the minimum runtime.

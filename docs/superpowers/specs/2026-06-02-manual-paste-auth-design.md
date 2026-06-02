# Manual paste-code OAuth flow (no auto-browser)

Date: 2026-06-02
Status: Design — pending implementation

## Problem

The OAuth `authorization_code` login can already run without auto-opening a
browser via `--browser none` / `headless`: it prints the authorization URL and
waits for the callback on `http://0.0.0.0:<browser-auth-port>/callback`.

That covers the **local** case (browser on the same machine as the process, so
the localhost redirect reaches the callback server). It does **not** cover the
**remote** case: when the browser is on a different machine than the proxy
(server / container / SSH), the `localhost` redirect never reaches the callback
server, so login can never complete. There is also no way to finish the flow by
**pasting the authorization code manually**.

This must work in both consumers of the shared auth layer:
- `@mcp-abap-adt/proxy` (this repo)
- `mcp-abap-adt` ("mcp-auth")

Both only pass `browser: 'none'` to the shared package, so the feature belongs
in the shared layer and both get it via a dependency bump — no consumer code
change.

Out of scope: the 30s auth timeout is acceptable as-is and is **not** changed.

## Where

`@mcp-abap-adt/auth-providers` → `src/auth/browserAuth.ts`, function
`startBrowserAuth`. The callback HTTP server already runs on the redirect port
bound to `0.0.0.0`. We extend the `none` / `headless` branch (server already
listening) to accept the code through two additional channels alongside the
existing auto-callback.

## Mechanism — three racing channels, first one wins

A single OAuth login attempt completes when **any** of these produces a valid
code; the existing `resolved` guard prevents double-resolution, and on success
all channels are torn down (server closed, stdin listener removed).

1. **Auto callback** (existing): `GET /callback?code=...` — local case.
2. **HTML paste form** (new): `GET /` serves a small form. The user — whose
   browser sat on the failed `localhost/callback?code=XXX` redirect — copies the
   `code` (or the whole redirected URL) and submits it. The form targets the
   existing `/callback` handler (or a thin `/submit` that extracts the code from
   a pasted full URL), which runs the existing `exchangeCodeForToken`. Works
   remotely and when the process is spawned by an MCP client (no TTY needed),
   because the server listens on `0.0.0.0:<port>`.
3. **stdin paste** (new): only when `process.stdin.isTTY === true`. Attach a
   `readline` listener; a pasted line is treated as a code (or a full URL from
   which the `code` query param is extracted) and run through
   `exchangeCodeForToken`. **Gated strictly on `isTTY`** so that stdio-transport
   processes (where stdin is the MCP protocol channel) never have their stdin
   consumed.

### Console instructions in `none` / `headless` mode

Print clearly:
- the authorization URL to open;
- that it waits for the callback on `http://localhost:<port>/callback`;
- remote hint: "If your browser is on another machine, after login copy the
  `code` from the address bar and either paste it at
  `http://<host>:<port>/` or paste it here in the terminal."

## Components / boundaries

- `startBrowserAuth` (browserAuth.ts) — owns the server lifecycle and now wires
  the three channels into one promise. Single source of truth for resolve/reject
  and cleanup.
- `exchangeCodeForToken` (existing, exported) — unchanged; reused by all
  channels.
- A small `extractCode(input)` helper — accepts a bare code or a full
  `...?code=XXX[&...]` URL and returns the code. Used by form + stdin channels.
- stdin channel is additive and self-removing; it must not change behavior when
  `isTTY` is false.

## Error handling

- Invalid / empty pasted code → show a friendly error on the form (re-render
  with message) or a stderr line for stdin, and keep waiting (do not reject the
  whole flow on a single bad paste).
- Token exchange failure → same reject path as the existing callback handler.
- Existing 30s timeout and existing cleanup-on-signal logic are preserved.

## Testing

In `@mcp-abap-adt/auth-providers`:
- `extractCode` unit tests: bare code; full localhost URL; full proxy-host URL;
  URL with extra params; garbage input.
- `none` mode serves the paste form at `/` (HTTP GET returns 200 + form).
- Pasting a code at the form completes the flow (mock `exchangeCodeForToken`).
- stdin channel attaches only when `isTTY` true; never reads stdin when false.
- `resolved` guard: simulate callback + paste arriving together → single
  resolution, no crash.

## Rollout (cross-package-fix-cycle)

1. Implement + test in `@mcp-abap-adt/auth-providers`. Release minor
   `1.0.5 → 1.1.0` (new feature, backward compatible). Publish.
2. Bump `@mcp-abap-adt/auth-providers` in **this proxy** and in
   `mcp-abap-adt`; verify build/tests; release each.
   - Neither consumer needs code changes; the proxy `--help` already documents
     `--browser none`. Optionally add a one-line paste hint to the help.

## Consumer-side note

The proxy requires no source change. The earlier platform-aware service-key
path fixes (help text + error hint) are independent and already merged.

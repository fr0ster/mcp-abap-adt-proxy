# Design: Env-variable interpolation + `.env` support in proxy config

Date: 2026-06-03
Status: Active (not yet implemented)

## Background

GitHub issue #4 asks to confirm and document `defaultHeaders` as the per-user
auth-injection point. The upstream `cloud-llm-hub` is a **shared** server with no
default SAP service user, so on-premise / `NoAuthentication` destinations require
each caller's own `x-sap-login` / `x-sap-password` on every request. The proxy
runs **locally on each user's machine**, so it is the right place to hold the
user's identity.

The original issue framing stored those credentials as plaintext in the YAML
config. That is unacceptable in practice because:

- The proxy is installed as a **global command**; the YAML config and any secret
  file live **outside the repository**, somewhere user-local.
- The working directory at launch time is unpredictable (the MCP client spawns
  the binary from wherever it runs), so auto-discovery of a `.env` from `cwd` is
  unreliable.

This design replaces "plaintext in YAML" with environment-variable interpolation
plus an explicitly-pointed `.env` file.

## Goals

- Let config values reference environment variables instead of embedding secrets.
- Support an explicitly-specified `.env` file as a value source.
- Fail fast at startup when the config references a variable that cannot be
  resolved, so a request never silently goes out with an empty password.

## Non-goals

- No auto-discovery of `.env` from `cwd` or any implicit search path.
- No change to header merge precedence or JWT injection (`Authorization` is still
  proxy-managed and cannot be set via `defaultHeaders`).

## Interpolation syntax

In the YAML/JSON config, any **string** value may contain placeholders:

- `${VAR}` — substitute the value of `VAR`.
- `${VAR:-default}` — substitute `VAR`, or `default` when `VAR` is unset/empty.

Interpolation applies to all string values in the parsed config object
(recursively), including `defaultHeaders` values, `targetUrl`, etc. Non-string
values (numbers, booleans) are left untouched.

A literal `$` that is not part of a `${...}` placeholder is left as-is.

## Value sources (priority, highest first)

1. `process.env` — variables exported in the shell or passed by the MCP client.
2. `.env` file, specified **explicitly** (never auto-discovered):
   - `envFile: <path>` field inside the YAML config — resolved **relative to the
     directory of the config file**.
   - `--env-file <path>` CLI flag — overrides `envFile` from the YAML.
3. `${VAR:-default}` fallback — used only when the variable is absent from both
   sources above.

`process.env` wins over `.env` (standard dotenv semantics): an exported variable
overrides the same key in the `.env` file.

## Failure behavior

- A `${VAR}` placeholder **without** a default that cannot be resolved from any
  source → **fail fast at startup** with a clear error naming the variable and
  where it was referenced, e.g.:

  ```
  Config references undefined env variable: SAP_PASSWORD
  (referenced in defaultHeaders.x-sap-password)
  ```

- A `${VAR:-default}` placeholder never fails; it uses the default.
- A config with no placeholders triggers no checks.

## Implementation

New dependency: `dotenv` (used only via `dotenv.parse()` on file contents — no
implicit `dotenv.config()` / `process.env` mutation).

Changes in `src/lib/config.ts`:

1. Resolve the `.env` path:
   - `--env-file <path>` if present (absolute, or relative to cwd);
   - else `envFile` from the raw config, resolved relative to the config file's
     directory;
   - else no `.env`.
2. Parse the `.env` (if any) into a plain map with `dotenv.parse()`.
3. Build a lookup function: `key => process.env[key] ?? envFileMap[key]`.
4. Recursively interpolate all string values of the **raw parsed config object**
   (before `applyDefaults` / `mergeCliOverrides`), using the lookup and the
   `${VAR}` / `${VAR:-default}` grammar.
5. On an unresolved no-default placeholder, throw with the variable name and a
   best-effort path to the referencing field.
6. Add `--env-file` to CLI argument parsing. `envFile` is a config-file-only
   field (not part of the runtime `ProxyConfig` surface used downstream).

Interpolation runs only on the file-config path (`--config`). The env-only path
(`loadFromEnv`, no `--config`) already reads `process.env` directly and is
unchanged, except `--env-file` is honored there too if supplied (parsed and
merged into the lookup for any `--header` values containing placeholders).

## Documentation

- `docs/mcp-proxy-config.example.yaml` — show `x-sap-login: ${SAP_USER}` /
  `x-sap-password: ${SAP_PASSWORD}` and an `envFile:` entry; replace the
  "plaintext + chmod 600" note with the env-var / `.env` approach.
- `README.md` — update the Default Headers section: per-user ABAP credentials via
  `${VAR}` and `.env`, not plaintext.
- `docs/YAML_CONFIG.md` / `docs/CONFIGURATION.md` — document `envFile`,
  `--env-file`, the `${VAR}` / `${VAR:-default}` syntax, source priority, and
  fail-fast behavior.
- Note that the `.env` file is also user-local and must not be committed.

## Testing

- `${VAR}` substitution from `process.env`.
- `${VAR}` substitution from a parsed `.env` map.
- `process.env` takes priority over `.env` for the same key.
- `${VAR:-default}` uses the default when unset, and the value when set.
- `envFile` path resolved relative to the config file directory.
- `--env-file` overrides `envFile` from YAML.
- Fail-fast: unresolved no-default placeholder throws an error naming the
  variable.
- No placeholders → config loads unchanged.
- Non-string values are not touched by interpolation.

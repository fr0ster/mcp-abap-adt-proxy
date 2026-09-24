/**
 * Environment-variable interpolation for proxy configuration.
 * Supports ${VAR} and ${VAR:-default} in string values.
 */

import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Resolve ${VAR} / ${VAR:-default} placeholders in a single string.
 * Empty-string follows bash `:-` semantics: an empty value falls back to the
 * default when one is given. A ${VAR} without a default that resolves to
 * undefined throws, naming the variable and the field it came from.
 */
export function interpolateString(
  input: string,
  lookup: (key: string) => string | undefined,
  fieldPath: string,
  /** Where values were looked for, named in the failure. */
  sources = 'process.env',
): string {
  return input.replace(
    PLACEHOLDER,
    (_match: string, name: string, defaultVal?: string): string => {
      const value = lookup(name);
      const isEmpty = value === undefined || value === '';
      if (defaultVal !== undefined) {
        return isEmpty ? defaultVal : (value as string);
      }
      if (value === undefined) {
        // Naming where it looked, because the old message named only the
        // variable — so a file never read, a file read empty, and a value
        // shadowed by the environment all produced the same sentence and the
        // cause had to be guessed.
        throw new Error(
          `Config references undefined env variable: ${name} ` +
            `(referenced in ${fieldPath}; looked in ${sources})`,
        );
      }
      return value;
    },
  );
}

/**
 * Recursively interpolate all string values in a parsed config object.
 * Objects/arrays are walked; non-string scalars are returned unchanged.
 * The field path (e.g. `defaultHeaders.x-sap-password`) is threaded through for
 * error messages.
 */
export function interpolateConfig(
  value: unknown,
  lookup: (key: string) => string | undefined,
  path = '',
  sources = 'process.env',
): unknown {
  if (typeof value === 'string') {
    return interpolateString(value, lookup, path || '(root)', sources);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      interpolateConfig(item, lookup, `${path}[${i}]`, sources),
    );
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = interpolateConfig(
        val,
        lookup,
        path ? `${path}.${key}` : key,
        sources,
      );
    }
    return out;
  }
  return value;
}

/**
 * Parse a .env file into a flat map. Throws if the path is given but missing —
 * a specified-yet-absent secret source is a configuration error, not a no-op.
 */
export function loadEnvFile(envFilePath: string): Record<string, string> {
  if (!fs.existsSync(envFilePath)) {
    throw new Error(`env file not found: ${envFilePath}`);
  }
  // Not an error when it yields nothing: an empty `.env` is legitimate, and a
  // config may take every value from the environment. But the emptiness is
  // reported by whoever needs a variable — see the `sources` note threaded into
  // the interpolation failure, which names the file, its size and its key count.
  return dotenv.parse(fs.readFileSync(envFilePath, 'utf-8'));
}

/**
 * Build a lookup over process.env (highest priority) then the parsed .env map.
 *
 * An EMPTY environment variable does not count as a value. It used to: `??`
 * skips only `undefined`, so a `SAP_LOGIN=` sitting in the environment won
 * against the env file the user had explicitly pointed at with `--env-file`,
 * and the header went out empty with nothing reported. Windows carries
 * variables nobody set deliberately, which is why the same config and the same
 * `.env` behaved differently there.
 *
 * A real value in the environment still wins — that is the documented
 * precedence, and it is how a one-off override is meant to work.
 */
export function buildLookup(
  envFileMap: Record<string, string>,
): (key: string) => string | undefined {
  return (key: string): string | undefined => {
    const fromEnvironment = process.env[key];
    if (fromEnvironment !== undefined && fromEnvironment !== '') {
      return fromEnvironment;
    }
    return envFileMap[key];
  };
}

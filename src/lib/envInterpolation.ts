/**
 * Environment-variable interpolation for proxy configuration.
 * Supports ${VAR} and ${VAR:-default} in string values.
 */

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
        throw new Error(
          `Config references undefined env variable: ${name} (referenced in ${fieldPath})`,
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
): unknown {
  if (typeof value === 'string') {
    return interpolateString(value, lookup, path || '(root)');
  }
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      interpolateConfig(item, lookup, `${path}[${i}]`),
    );
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = interpolateConfig(val, lookup, path ? `${path}.${key}` : key);
    }
    return out;
  }
  return value;
}

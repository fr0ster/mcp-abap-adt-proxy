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

import { describe, it, expect } from '@jest/globals';
import { interpolateString } from '../../lib/envInterpolation.js';

const lookup =
  (map: Record<string, string | undefined>) => (k: string) => map[k];

describe('interpolateString', () => {
  it('substitutes ${VAR} from the lookup', () => {
    const out = interpolateString('${USER}', lookup({ USER: 'alice' }), 'f');
    expect(out).toBe('alice');
  });

  it('substitutes inside a larger string', () => {
    const out = interpolateString('Bearer ${TOK}!', lookup({ TOK: 'x' }), 'f');
    expect(out).toBe('Bearer x!');
  });

  it('uses the default when the variable is unset', () => {
    const out = interpolateString('${MISS:-fallback}', lookup({}), 'f');
    expect(out).toBe('fallback');
  });

  it('uses the default when the variable is empty', () => {
    const out = interpolateString('${E:-fallback}', lookup({ E: '' }), 'f');
    expect(out).toBe('fallback');
  });

  it('prefers the set value over the default', () => {
    const out = interpolateString('${V:-d}', lookup({ V: 'real' }), 'f');
    expect(out).toBe('real');
  });

  it('keeps an empty value for ${VAR} with no default', () => {
    const out = interpolateString('${E}', lookup({ E: '' }), 'f');
    expect(out).toBe('');
  });

  it('throws naming the variable and field when unresolved and no default', () => {
    expect(() =>
      interpolateString('${MISS}', lookup({}), 'defaultHeaders.x-sap-password'),
    ).toThrow(/MISS.*defaultHeaders\.x-sap-password/);
  });

  it('leaves a literal $ untouched', () => {
    expect(interpolateString('price $5', lookup({}), 'f')).toBe('price $5');
  });
});

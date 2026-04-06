import { describe, it, expect, afterEach } from '@jest/globals';
import { loadConfig } from '../../lib/config.js';

describe('config', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  describe('defaultHeaders from CLI', () => {
    it('should parse single --header argument', () => {
      process.argv = ['node', 'proxy', '--header', 'x-sap-destination=S4HANA'];
      const config = loadConfig();
      expect(config.defaultHeaders).toEqual({ 'x-sap-destination': 'S4HANA' });
    });

    it('should parse multiple --header arguments', () => {
      process.argv = [
        'node', 'proxy',
        '--header', 'x-sap-destination=S4HANA',
        '--header', 'x-sap-client=100',
      ];
      const config = loadConfig();
      expect(config.defaultHeaders).toEqual({
        'x-sap-destination': 'S4HANA',
        'x-sap-client': '100',
      });
    });

    it('should parse --header=key=value format', () => {
      process.argv = ['node', 'proxy', '--header=x-sap-destination=S4HANA'];
      const config = loadConfig();
      expect(config.defaultHeaders).toEqual({ 'x-sap-destination': 'S4HANA' });
    });

    it('should return undefined when no --header arguments', () => {
      process.argv = ['node', 'proxy'];
      const config = loadConfig();
      expect(config.defaultHeaders).toBeUndefined();
    });
  });
});

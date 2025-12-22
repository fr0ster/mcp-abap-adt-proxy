/**
 * Test logger utilities for controlling debug output during tests
 * Based on @mcp-abap-adt/logger package
 * 
 * Environment variables:
 * - DEBUG_TESTS=true - Enable logs from tests (INFO, WARN, ERROR)
 * - DEBUG_TESTS=verbose - Enable verbose test logs (includes DEBUG level)
 * - DEBUG_PACKAGE_<NAME>=true - Enable logs from specific package (INFO, WARN, ERROR)
 * - DEBUG_PACKAGE_<NAME>=verbose - Enable verbose logs for specific package (includes DEBUG)
 * - DEBUG_VERBOSE=true - Global verbose flag (applies to all enabled loggers)
 * 
 * Available package names: AUTH_BROKER, AUTH_PROVIDERS, AUTH_STORES, CONNECTION, HEADER_VALIDATOR, LOGGER
 */


import { LogLevel } from '@mcp-abap-adt/logger';

/**
 * Get log level based on verbose flag
 */
function getTestLogLevel(verbose: boolean): LogLevel {
  return verbose ? LogLevel.DEBUG : LogLevel.INFO;
}

/**
 * Check if value indicates verbose mode
 */
function isVerbose(value: string | undefined): boolean {
  return value === 'verbose' || value === 'true' && process.env.DEBUG_VERBOSE === 'true';
}

/**
 * Test logger implementation - based on LogLevel from @mcp-abap-adt/logger
 * Controls output based on DEBUG_TESTS environment variable
 */
class TestLoggerImpl implements ILogger {
  private enabled: boolean;
  private verbose: boolean;
  private testLogLevel: LogLevel;

  constructor() {
    const debugTests = process.env.DEBUG_TESTS;
    this.enabled = debugTests !== undefined && debugTests !== 'false';
    this.verbose = isVerbose(debugTests);
    this.testLogLevel = getTestLogLevel(this.verbose);
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.enabled) {
      return false;
    }

    // In verbose mode, show all levels including DEBUG
    // In non-verbose mode, show INFO, WARN, ERROR (skip DEBUG)
    if (level === LogLevel.DEBUG && !this.verbose) {
      return false;
    }

    return level <= this.testLogLevel;
  }

  private log(level: LogLevel, levelStr: string, message: string, meta?: any): void {
    if (this.shouldLog(level)) {
      const timestamp = new Date().toISOString();
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
      // Use process.stdout.write to avoid Jest stack trace
      process.stdout.write(`[${timestamp}] [TEST] [${levelStr}] ${message}${metaStr}\n`);
    }
  }

  info(message: string, meta?: any): void {
    this.log(LogLevel.INFO, 'INFO', message, meta);
  }

  debug(message: string, meta?: any): void {
    this.log(LogLevel.DEBUG, 'DEBUG', message, meta);
  }

  warn(message: string, meta?: any): void {
    this.log(LogLevel.WARN, 'WARN', message, meta);
  }

  error(message: string, meta?: any): void {
    this.log(LogLevel.ERROR, 'ERROR', message, meta);
  }
}

/**
 * Package logger implementation - based on LogLevel from @mcp-abap-adt/logger
 * Controls output based on DEBUG_PACKAGE_<NAME> environment variable
 */
class PackageLoggerImpl implements ILogger {
  private packageName: string;
  private enabled: boolean;
  private verbose: boolean;
  private packageLogLevel: LogLevel;

  constructor(packageName: string) {
    this.packageName = packageName.toUpperCase();
    const envKey = `DEBUG_PACKAGE_${this.packageName}`;
    const debugValue = process.env[envKey];
    this.enabled = debugValue !== undefined && debugValue !== 'false';
    this.verbose = isVerbose(debugValue);
    this.packageLogLevel = getTestLogLevel(this.verbose);
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.enabled) {
      return false;
    }

    // In verbose mode, show all levels including DEBUG
    // In non-verbose mode, show INFO, WARN, ERROR (skip DEBUG)
    if (level === LogLevel.DEBUG && !this.verbose) {
      return false;
    }

    return level <= this.packageLogLevel;
  }

  private log(level: LogLevel, levelStr: string, message: string, meta?: any): void {
    if (this.shouldLog(level)) {
      const timestamp = new Date().toISOString();
      const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
      // Use process.stdout.write to avoid Jest stack trace
      process.stdout.write(`[${timestamp}] [PKG:${this.packageName}] [${levelStr}] ${message}${metaStr}\n`);
    }
  }

  info(message: string, meta?: any): void {
    this.log(LogLevel.INFO, 'INFO', message, meta);
  }

  debug(message: string, meta?: any): void {
    this.log(LogLevel.DEBUG, 'DEBUG', message, meta);
  }

  warn(message: string, meta?: any): void {
    this.log(LogLevel.WARN, 'WARN', message, meta);
  }

  error(message: string, meta?: any): void {
    this.log(LogLevel.ERROR, 'ERROR', message, meta);
  }
}

// Export singleton instances
export const testLogger: ILogger = new TestLoggerImpl();

// Export loggers for each package
export const authBrokerLogger: ILogger = new PackageLoggerImpl('AUTH_BROKER');
export const authProvidersLogger: ILogger = new PackageLoggerImpl('AUTH_PROVIDERS');
export const authStoresLogger: ILogger = new PackageLoggerImpl('AUTH_STORES');
export const connectionLogger: ILogger = new PackageLoggerImpl('CONNECTION');
export const headerValidatorLogger: ILogger = new PackageLoggerImpl('HEADER_VALIDATOR');
export const loggerPackageLogger: ILogger = new PackageLoggerImpl('LOGGER');

/**
 * Helper function to get logger for a specific package
 * Use this in tests when creating package instances
 * 
 * @example
 * const logger = getPackageLogger('AUTH_BROKER');
 * const broker = new AuthBroker(stores, 'none', logger);
 */
export function getPackageLogger(packageName: string): ILogger {
  const packageNameUpper = packageName.toUpperCase();
  switch (packageNameUpper) {
    case 'AUTH_BROKER':
      return authBrokerLogger;
    case 'AUTH_PROVIDERS':
      return authProvidersLogger;
    case 'AUTH_STORES':
      return authStoresLogger;
    case 'CONNECTION':
      return connectionLogger;
    case 'HEADER_VALIDATOR':
      return headerValidatorLogger;
    case 'LOGGER':
      return loggerPackageLogger;
    default:
      // Return logger package logger as fallback
      return loggerPackageLogger;
  }
}

// Map package identifiers to loggers
const packageLoggers: Map<string, ILogger> = new Map([
  ['auth-broker', authBrokerLogger],
  ['auth-providers', authProvidersLogger],
  ['auth-stores', authStoresLogger],
  ['connection', connectionLogger],
  ['header-validator', headerValidatorLogger],
  ['logger', loggerPackageLogger],
]);

/**
 * Check if any package logger is enabled
 */
function isAnyPackageLoggerEnabled(): boolean {
  return Array.from(packageLoggers.values()).some(
    (logger) => (logger as PackageLoggerImpl)['enabled']
  );
}

/**
 * Intercept console.error calls from packages and route them through appropriate package logger
 */
const originalError = console.error;

// Only intercept if at least one package logger is enabled or test logger is enabled
const hasTestLogs = process.env.DEBUG_TESTS !== undefined && process.env.DEBUG_TESTS !== 'false';
const hasPackageLogs = isAnyPackageLoggerEnabled();

if (hasTestLogs || hasPackageLogs) {
  // Intercept console.error
  console.error = (...args: unknown[]) => {
    const message = args.map(arg => 
      typeof arg === 'string' ? arg : JSON.stringify(arg)
    ).join(' ');

    // Note: testLogger and packageLogger now use process.stdout.write directly,
    // so they won't be intercepted here. This interceptor only handles logs from
    // other sources (like logger?.ts from packages)

    // Check if this looks like a log from our logger?.ts (has timestamp and prefix pattern)
    // Pattern: [timestamp] [PREFIX] message
    const logPattern = /^\[.*?\] \[(DEBUG|INFO|WARN|ERROR)\]/;
    const match = message.match(logPattern);

    if (match) {
      // This is a log from our logger?.ts
      const levelStr = match[1].toLowerCase() as 'debug' | 'info' | 'warn' | 'error';
      
      // Extract the actual message (everything after the prefix)
      const messageMatch = message.match(/^\[.*?\] \[.*?\] (.*)$/);
      const actualMessage = messageMatch ? messageMatch[1] : message;

      // Try to detect package name from message or use 'logger' as default
      // For now, we'll use 'logger' as default, but this can be enhanced
      // by adding package name to log format in logger?.ts
      const packageName = 'logger';
      const logger = packageLoggers.get(packageName);
      
      if (logger) {
        // Route through appropriate package logger
        logger[levelStr](actualMessage);
      } else {
        // Fallback to original if no logger found
        originalError(...args);
      }
    } else {
      // Not a log from our logger, check if any logger is enabled
      if (hasTestLogs || hasPackageLogs) {
        // Show other console.error output if any logger is enabled
        originalError(...args);
      }
    }
  };
} else {
  // Suppress all console.error output if no debug flags are set
  console.error = () => {};
}

/**
 * Restore original console.error (for cleanup if needed)
 */
export function restoreConsoleError(): void {
  console.error = originalError;
}

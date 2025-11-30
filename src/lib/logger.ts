/**
 * Logger utility for MCP ABAP ADT Proxy
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

class SimpleLogger implements Logger {
  private level: LogLevel;

  constructor(level: LogLevel = LogLevel.INFO) {
    this.level = level;
  }

  private log(level: LogLevel, prefix: string, message: string, meta?: Record<string, unknown>): void {
    if (level < this.level) {
      return;
    }

    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    console.error(`[${timestamp}] [${prefix}] ${message}${metaStr}`);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, 'DEBUG', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, 'INFO', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, 'WARN', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, 'ERROR', message, meta);
  }
}

// Default logger instance
export const logger: Logger = new SimpleLogger(
  process.env.LOG_LEVEL?.toUpperCase() 
    ? (LogLevel[process.env.LOG_LEVEL.toUpperCase() as keyof typeof LogLevel] ?? LogLevel.INFO)
    : LogLevel.INFO
);


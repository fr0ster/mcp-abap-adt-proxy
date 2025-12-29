/**
 * Error Handling & Resilience utilities
 */

import { logger } from './logger.js';

export interface RetryOptions {
  maxRetries: number;
  retryDelay: number;
  retryableStatusCodes?: number[];
  retryableErrors?: string[];
}

/**
 * Check if error is retryable
 */
export function isRetryableError(
  error: unknown,
  retryableStatusCodes: number[] = [500, 502, 503, 504],
): boolean {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status && retryableStatusCodes.includes(status)) {
      return true;
    }

    // Network errors are retryable
    if (!error.response && error.request) {
      return true;
    }
  }

  // Token expiration errors are retryable (will be handled separately)
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes('token') &&
      (message.includes('expired') || message.includes('invalid'))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxRetries,
    retryDelay,
    retryableStatusCodes = [500, 502, 503, 504],
  } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Check if error is retryable
      if (!isRetryableError(error, retryableStatusCodes)) {
        logger?.debug('Error is not retryable, stopping retries', {
          type: 'RETRY_STOPPED',
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Calculate backoff delay (exponential backoff)
      const delay = retryDelay * 2 ** attempt;

      logger?.warn('Retrying after error', {
        type: 'RETRY_ATTEMPT',
        attempt: attempt + 1,
        maxRetries,
        delay,
        error: error instanceof Error ? error.message : String(error),
      });

      await sleep(delay);
    }
  }

  // All retries exhausted
  logger?.error('All retry attempts exhausted', {
    type: 'RETRY_EXHAUSTED',
    maxRetries,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });

  throw lastError;
}

/**
 * Circuit Breaker implementation
 */
export class CircuitBreaker {
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold: number = 5,
    private timeout: number = 60000,
  ) {}

  /**
   * Check if circuit breaker allows request
   */
  canProceed(): boolean {
    const now = Date.now();

    if (this.state === 'open') {
      // Check if timeout has passed
      if (now - this.lastFailureTime >= this.timeout) {
        this.state = 'half-open';
        logger?.info('Circuit breaker entering half-open state', {
          type: 'CIRCUIT_BREAKER_HALF_OPEN',
        });
        return true;
      }
      return false;
    }

    return true;
  }

  /**
   * Record success
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = 0;
      logger?.info('Circuit breaker closed after successful request', {
        type: 'CIRCUIT_BREAKER_CLOSED',
      });
    } else if (this.state === 'closed') {
      this.failures = 0;
    }
  }

  /**
   * Record failure
   */
  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.threshold) {
      this.state = 'open';
      logger?.error('Circuit breaker opened due to failures', {
        type: 'CIRCUIT_BREAKER_OPENED',
        failures: this.failures,
        threshold: this.threshold,
      });
    }
  }

  /**
   * Get current state
   */
  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }

  /**
   * Reset circuit breaker
   */
  reset(): void {
    this.failures = 0;
    this.lastFailureTime = 0;
    this.state = 'closed';
    logger?.info('Circuit breaker reset', {
      type: 'CIRCUIT_BREAKER_RESET',
    });
  }
}

/**
 * Handle token expiration errors
 */
export function isTokenExpirationError(error: unknown): boolean {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return true;
    }
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('token') &&
      (message.includes('expired') ||
        message.includes('invalid') ||
        message.includes('unauthorized'))
    );
  }

  return false;
}

/**
 * Create error response in MCP format
 */
export function createErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): {
  jsonrpc: string;
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
} {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

// Import axios for type checking
import axios from 'axios';

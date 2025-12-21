// Jest setup file - suppress console.error during tests
// Logger uses console.error for info/warn/error logs, which clutters test output
// 
// Environment variables for controlling test output:
// - DEBUG_TESTS=true - Enable logs from tests
// - DEBUG_TESTS_VERBOSE=true - Enable verbose test logs (includes DEBUG level)
// - DEBUG_PACKAGE_<NAME>=true - Enable logs from specific package (e.g., DEBUG_PACKAGE_AUTH_BROKER=true)
// - DEBUG_PACKAGE_<NAME>_VERBOSE=true - Enable verbose logs for specific package
// 
// Available package names: AUTH_BROKER, AUTH_PROVIDERS, AUTH_STORES, CONNECTION, HEADER_VALIDATOR, LOGGER

// Import test logger to set up package log interception
require('./src/__tests__/helpers/testLogger.js');

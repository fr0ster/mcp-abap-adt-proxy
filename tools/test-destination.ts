#!/usr/bin/env node

/**
 * Test script for checking destination service key loading and token retrieval
 * 
 * Usage:
 *   npm run test-destination -- mcp
 *   npm run test-destination -- mcp --xsuaa
 *   npm run test-destination -- mcp --abap
 */

import { getPlatformStores } from '../src/lib/stores.js';
import { AuthBroker } from '@mcp-abap-adt/auth-broker';
import { XsuaaTokenProvider, BtpTokenProvider } from '@mcp-abap-adt/auth-providers';

async function testDestination(destination: string, useXsuaa: boolean = true) {
  console.log(`\n🔍 Testing destination: "${destination}"`);
  console.log(`   Store type: ${useXsuaa ? 'XSUAA' : 'ABAP'}`);
  console.log(`   Provider: ${useXsuaa ? 'XsuaaTokenProvider' : 'BtpTokenProvider'}\n`);

  try {
    // Get stores
    const { serviceKeyStore, sessionStore } = await getPlatformStores(false, useXsuaa);
    
    console.log(`✅ Stores created:`);
    console.log(`   ServiceKeyStore: ${serviceKeyStore.constructor.name}`);
    console.log(`   SessionStore: ${sessionStore.constructor.name}\n`);

    // Test 1: Check if service key exists
    console.log(`📋 Test 1: Reading service key...`);
    const serviceKey = await serviceKeyStore.getServiceKey(destination);
    if (!serviceKey) {
      console.error(`❌ Service key not found for destination "${destination}"`);
      return;
    }
    console.log(`✅ Service key found`);
    console.log(`   Keys: ${Object.keys(serviceKey).join(', ')}`);
    if ((serviceKey as any).uaa) {
      console.log(`   Has uaa object: yes`);
    }
    if ((serviceKey as any).url) {
      console.log(`   Has url: yes (${(serviceKey as any).url})`);
    }
    if ((serviceKey as any).clientid) {
      console.log(`   Has clientid: yes`);
    }
    if ((serviceKey as any).clientsecret) {
      console.log(`   Has clientsecret: yes`);
    }
    console.log('');

    // Test 2: Get authorization config
    console.log(`📋 Test 2: Getting authorization config...`);
    const authConfig = await serviceKeyStore.getAuthorizationConfig(destination);
    if (!authConfig) {
      console.error(`❌ Authorization config is null`);
      console.log(`   This means the service key format is not recognized by the parser`);
      return;
    }
    console.log(`✅ Authorization config retrieved`);
    console.log(`   uaaUrl: ${authConfig.uaaUrl || 'not set'}`);
    console.log(`   uaaClientId: ${authConfig.uaaClientId ? '***' + authConfig.uaaClientId.slice(-4) : 'not set'}`);
    console.log(`   uaaClientSecret: ${authConfig.uaaClientSecret ? '***' + authConfig.uaaClientSecret.slice(-4) : 'not set'}`);
    console.log('');

    // Test 3: Test token provider directly
    console.log(`📋 Test 3: Testing token provider directly...`);
    const tokenProvider = useXsuaa ? new XsuaaTokenProvider() : new BtpTokenProvider();
    console.log(`   Provider: ${tokenProvider.constructor.name}`);
    
    try {
      const result = await tokenProvider.getConnectionConfig(authConfig);
      if (result.connectionConfig?.authorizationToken) {
        console.log(`✅ Token obtained successfully`);
        console.log(`   Token length: ${result.connectionConfig.authorizationToken.length}`);
        console.log(`   Token preview: ${result.connectionConfig.authorizationToken.substring(0, 50)}...`);
      } else {
        console.error(`❌ Token provider returned no token`);
      }
    } catch (error) {
      console.error(`❌ Token provider failed:`);
      console.error(`   ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        console.error(`   Stack: ${error.stack}`);
      }
      return;
    }
    console.log('');

    // Test 4: Test AuthBroker
    console.log(`📋 Test 4: Testing AuthBroker...`);
    
    // Create initial session BEFORE creating broker (same as proxy does)
    // AuthBroker's setConnectionConfig requires existing session
    try {
      const connConfig = await serviceKeyStore.getConnectionConfig(destination);
      if (authConfig) {
        if (useXsuaa) {
          // For XSUAA: create session with authConfig and placeholder token
          // serviceUrl is optional for XSUAA
          const sessionData: any = {
            ...authConfig,
            jwtToken: "placeholder", // Placeholder to pass validation, will be replaced by AuthBroker
          };
          if (connConfig?.serviceUrl) {
            sessionData.serviceUrl = connConfig.serviceUrl;
          }
          
          console.log(`   📝 Creating initial XSUAA session with placeholder token...`);
          await sessionStore.saveSession(destination, sessionData);
          console.log(`   ✅ Initial session created`);
        } else {
          // For ABAP: create session with serviceUrl and placeholder token
          if (connConfig && connConfig.serviceUrl) {
            const sessionData: any = {
              ...authConfig,
              serviceUrl: connConfig.serviceUrl,
              jwtToken: "placeholder", // Placeholder to pass validation, will be replaced by AuthBroker
              sapClient: connConfig.sapClient,
              language: connConfig.language,
            };
            
            console.log(`   📝 Creating initial ABAP session with serviceUrl and placeholder token...`);
            await sessionStore.saveSession(destination, sessionData);
            console.log(`   ✅ Initial session created`);
          } else {
            console.log(`   ⚠️  Missing connConfig.serviceUrl for ABAP, skipping initial session creation`);
          }
        }
      } else {
        console.log(`   ⚠️  Missing authConfig, skipping initial session creation`);
      }
    } catch (error) {
      console.log(`   ⚠️  Could not create initial session: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Create a logger to see what AuthBroker is doing
    const testLogger = {
      debug: (message: string) => {
        console.log(`   [DEBUG] ${message}`);
      },
      info: (message: string) => {
        console.log(`   [INFO] ${message}`);
      },
      warn: (message: string) => {
        console.log(`   [WARN] ${message}`);
      },
      error: (message: string) => {
        console.log(`   [ERROR] ${message}`);
      },
    };
    
    const authBroker = new AuthBroker(
      {
        serviceKeyStore,
        sessionStore,
        tokenProvider,
      },
      useXsuaa ? 'none' : 'system',
      testLogger as any
    );
    
    console.log(`   Browser parameter: ${useXsuaa ? 'none' : 'system'}`);
    console.log(`   TokenProvider type: ${tokenProvider.constructor.name}\n`);
    
    try {
      const token = await authBroker.getToken(destination);
      console.log(`✅ AuthBroker.getToken() succeeded`);
      console.log(`   Token length: ${token.length}`);
      console.log(`   Token preview: ${token.substring(0, 50)}...`);
    } catch (error) {
      console.error(`❌ AuthBroker.getToken() failed:`);
      console.error(`   ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        // Show only relevant part of stack
        const stackLines = error.stack.split('\n').slice(0, 5);
        console.error(`   Stack (first 5 lines):`);
        stackLines.forEach(line => console.error(`     ${line}`));
      }
    }
    console.log('');

    // Test 5: Get connection config
    console.log(`📋 Test 5: Getting connection config...`);
    try {
      const connConfig = await serviceKeyStore.getConnectionConfig(destination);
      if (connConfig) {
        console.log(`✅ Connection config retrieved`);
        console.log(`   serviceUrl: ${connConfig.serviceUrl || 'not set'}`);
        console.log(`   sapClient: ${connConfig.sapClient || 'not set'}`);
        console.log(`   language: ${connConfig.language || 'not set'}`);
      } else {
        console.log(`⚠️  Connection config is null`);
      }
    } catch (error) {
      console.error(`❌ Failed to get connection config:`);
      console.error(`   ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log('');

    console.log(`✅ All tests completed for destination "${destination}"\n`);

  } catch (error) {
    console.error(`❌ Test failed:`);
    console.error(`   ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(`   Stack: ${error.stack}`);
    }
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: npm run test-destination -- <destination> [--xsuaa|--abap]');
    console.error('Example: npm run test-destination -- mcp --xsuaa');
    process.exit(1);
  }

  const destination = args[0];
  const useXsuaa = args.includes('--xsuaa') || (!args.includes('--abap') && true); // Default to XSUAA

  await testDestination(destination, useXsuaa);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});


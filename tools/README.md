# Tools

Utility scripts for testing and development.

## test-destination.ts

Verifies a BTP destination end to end: loads its service key, obtains a token via
the auth-broker, and reports the resolved target URL.

```bash
npm run test-destination
# or
npx tsx tools/test-destination.ts
```

## test-btp-auth.js

Manual check of the BTP authorization-code login flow for a destination.

```bash
node tools/test-btp-auth.js
```

## version-stats.sh

Prints release/version statistics for the package.

```bash
npm run chrono
```

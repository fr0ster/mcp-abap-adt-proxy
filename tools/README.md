# Tools

Utility scripts for testing and development.

## test-destination.ts

Verifies a BTP destination end to end, through `BtpProxy` itself: finds its
service key, obtains an authorization header (from the stored session, a
refresh, or a browser login) and reports the resolved target URL. No token is
printed, only its length.

```bash
npm run test-destination -- <destination> [--target-url <url>] [--browser <browser>]
# or
npx tsx tools/test-destination.ts <destination>
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

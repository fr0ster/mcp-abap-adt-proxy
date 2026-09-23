// src/mcp/ports.ts
import type { Server } from 'node:http';

/**
 * Bind a server to a free port and report the one it got.
 *
 * Port 0 asks the OS for a free port and binds it in the same step. The
 * alternative — probe for a free port, close, then bind it — leaves a window
 * in which another process can take it, which is exactly the collision this
 * exists to avoid. Nothing here guesses 3001.
 *
 * The listener is also the answer to "which port": `address()` is asked after
 * the bind, so the number reported is the number in use rather than the number
 * requested.
 */
export function listenOnFreePort(
  server: Server,
  host: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const failed = (error: Error) => {
      server.removeListener('listening', bound);
      reject(error);
    };
    const bound = () => {
      server.removeListener('error', failed);
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('Listening on a socket with no address'));
        return;
      }
      resolve(address.port);
    };

    server.once('error', failed);
    server.once('listening', bound);
    server.listen(0, host);
  });
}

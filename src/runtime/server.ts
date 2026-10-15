// HTTP server lifecycle: listen, report the bound address, and shut down cleanly. No framework, no hidden global state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RunningServer {
  /** The bound base URL, for example http://127.0.0.1:3000. Never contains a secret. */
  readonly url: string;
  close(): Promise<void>;
}

export async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  options: { host: string; port: number },
): Promise<RunningServer> {
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  // Connections that linger must not block a shutdown.
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? '[' + address.address + ']' : address.address;
  return {
    url: 'http://' + host + ':' + address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}

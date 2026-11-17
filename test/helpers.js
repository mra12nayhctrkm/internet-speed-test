import { createServer } from 'node:http';

/**
 * Start a local HTTP server on a random port.
 * @param {import('node:http').RequestListener} handler
 */
export async function startServer(handler) {
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy(); // don't wait on hung/keep-alive sockets
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/** Collects everything written to it. */
export function createSink() {
  let text = '';
  return {
    /** @param {string} chunk */
    write(chunk) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

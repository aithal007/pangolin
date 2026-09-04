// Minimal shape a connection needs for the heartbeat sweep - deliberately
// not importing `ws`'s WebSocket type or anything from @server/db, so this
// logic can be unit tested against plain fake objects without touching a
// real socket or the database.
export interface HeartbeatConnection {
    isAlive?: boolean;
    ping(): void;
    terminate(): void;
}

/**
 * One connection's turn in a heartbeat sweep, following the pattern
 * documented by the `ws` library itself for detecting broken connections:
 * https://github.com/websockets/ws#how-to-detect-and-close-broken-connections
 *
 * - If the connection didn't answer the *previous* ping (isAlive is still
 *   false from last sweep), it's unresponsive - terminate it.
 * - Otherwise, mark it unanswered and ping it. A "pong" handler elsewhere
 *   flips isAlive back to true when the client responds before the next
 *   sweep.
 *
 * Detection of a truly dead connection is bounded to between 1x and 2x the
 * sweep interval, instead of never happening on its own (no TCP keepalive
 * is configured on these sockets today).
 */
export function sweepConnection(connection: HeartbeatConnection): void {
    if (connection.isAlive === false) {
        connection.terminate();
        return;
    }
    connection.isAlive = false;
    connection.ping();
}

/**
 * Runs sweepConnection over every tracked connection. Takes a plain
 * iterable rather than the `connectedClients` Map type directly so it stays
 * decoupled from ws.ts's module state for testing.
 */
export function sweepAllConnections(
    connections: Iterable<HeartbeatConnection>
): void {
    for (const connection of connections) {
        sweepConnection(connection);
    }
}

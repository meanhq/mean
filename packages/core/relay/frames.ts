import type WebSocket from 'ws';
import type { RawData } from 'ws';

const CONTROL_LIMIT = 4096;
export const WALK_LIMIT: number = 256 * 1024;
export const ENVELOPE_OVERHEAD = 256;

// Returns the parsed frame, or closes the socket with the protocol's close code.
export function decodeFrame(
  socket: WebSocket,
  data: RawData,
  binary: boolean,
  fromMean: boolean,
): Record<string, unknown> | undefined {
  if (binary) {
    socket.close(1003);
    return;
  }
  const text = data.toString();
  const size = Buffer.byteLength(text);
  const overhead = fromMean ? ENVELOPE_OVERHEAD : 0;
  if (size > WALK_LIMIT + overhead) {
    socket.close(1009);
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    socket.close(1007);
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    socket.close(1007);
    return;
  }
  const value = message as Record<string, unknown>;
  if (value.v !== 1) {
    socket.close(1002);
    return;
  }
  const inner = fromMean ? value.message : value;
  const limit =
    inner && typeof inner === 'object' && (inner as Record<string, unknown>).type === 'walk.result'
      ? WALK_LIMIT
      : CONTROL_LIMIT;
  if (
    size > limit + overhead ||
    (fromMean && Buffer.byteLength(JSON.stringify(inner) ?? '') > limit)
  ) {
    socket.close(1009);
    return;
  }
  return value;
}

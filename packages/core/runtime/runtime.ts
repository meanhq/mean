import {
  type ErrorCode,
  isWalkRequest,
  MeanProtocolError,
  type WalkRequest,
} from '../../protocol/requests.js';
import { isRecord, isUuid, utf8Length } from '../../protocol/validation.js';
import { readViewport, type Viewport } from './viewport.js';
import type { Traversal, WalkPart } from './walk.js';

const PAGE_PATH = '/__mean/dom/v1';
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const CONTROL_LIMIT = 4096;
const ADAPTER_BUDGET_MS = 16;
// Spec, Walk algorithm and budget: 20 ms before the first part, 12 ms per later slice, 2 s in all.
// Sorting and serialising a part happen after the traversal stops, so each slice keeps a reserve.
const FIRST_SLICE_MS = 20;
const NEXT_SLICE_MS = 12;
const PART_RESERVE_MS = 2;
const WALK_WALL_MS = 2000;

// Read at probe time and compared again around the walk; never sent to Mean.
interface Snapshot {
  id: string;
  document: Document;
  href: string;
  title: string;
  scrollX: number;
  scrollY: number;
  viewport: Viewport;
}

// A walk between slices: the only time the runtime owns a timer.
interface PendingWalk {
  traversal: Traversal;
  timer: ReturnType<typeof setTimeout>;
  send(value: unknown): void;
}

type LazyModules = Promise<[typeof import('./walk.js'), typeof import('../../adapters/detect.js')]>;

export function startRuntime(
  pageToken: string,
  projectRoot: string,
  socketOrigin: string = location.origin,
): { reconnect(): void; dispose(): void } {
  let socket: WebSocket | undefined;
  let disposed = false;
  let hidden = false;
  let busy = false;
  let generation = 0;
  let snapshot: Snapshot | undefined;
  let modules: LazyModules | undefined;
  let pending: PendingWalk | undefined;

  const snapshotPage = (id: string): Snapshot | undefined => {
    const viewport = readViewport();
    return viewport
      ? {
          id,
          document,
          href: location.href,
          title: document.title,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          viewport,
        }
      : undefined;
  };
  const unchanged = (saved: Snapshot): boolean => {
    const now = snapshotPage(saved.id);
    return (
      !!now &&
      now.document === saved.document &&
      now.href === saved.href &&
      now.title === saved.title &&
      now.scrollX === saved.scrollX &&
      now.scrollY === saved.scrollY &&
      JSON.stringify(now.viewport) === JSON.stringify(saved.viewport)
    );
  };
  const stale = () => new MeanProtocolError('stale');

  // The unfinished walk closes with what it holds; nothing of it may run later.
  const cancelPending = (): void => {
    const current = pending;
    if (!current) return;
    pending = undefined;
    clearTimeout(current.timer);
    current.send(current.traversal.cancel());
  };

  function reconnect(): void {
    if (
      disposed ||
      hidden ||
      (socket &&
        (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))
    )
      return;
    snapshot = undefined;
    let url: URL;
    try {
      url = new URL(socketOrigin);
    } catch {
      return;
    }
    if (url.origin !== socketOrigin) return;
    url.pathname = PAGE_PATH;
    if (!LOOPBACK_HOSTS.includes(url.hostname) || !['http:', 'https:'].includes(url.protocol))
      return;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let current: WebSocket;
    try {
      current = new WebSocket(url.href, ['mean-dom-v1', pageToken]);
    } catch {
      return;
    }
    socket = current;
    const epoch = ++generation;
    current.addEventListener('close', () => {
      if (socket === current) {
        cancelPending();
        snapshot = undefined;
        busy = false;
        generation++;
      }
    });
    current.addEventListener('error', () => {
      current.close();
    });
    current.addEventListener('message', (event) => {
      void receive(event, current, epoch);
    });
  }

  // Returns the parsed request, or closes the socket with the protocol's close code.
  function decodeFrame(data: unknown, current: WebSocket): Record<string, unknown> | undefined {
    if (typeof data !== 'string') {
      current.close(1003);
      return;
    }
    if (utf8Length(data) > CONTROL_LIMIT) {
      current.close(1009);
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      current.close(1007);
      return;
    }
    if (!isRecord(message)) {
      current.close(1007);
      return;
    }
    if (message.v !== 1) {
      current.close(1002);
      return;
    }
    if (!isUuid(message.requestId)) {
      current.close(1007);
      return;
    }
    return message;
  }

  async function receive(event: MessageEvent, current: WebSocket, epoch: number): Promise<void> {
    if (disposed || epoch !== generation) return;
    const message = decodeFrame(event.data, current);
    if (!message) return;
    const requestId = message.requestId as string;
    const send = (value: unknown): void => {
      if (!disposed && epoch === generation && current.readyState === WebSocket.OPEN)
        current.send(JSON.stringify(value));
    };
    const fail = (code: ErrorCode): void => send({ v: 1, type: 'error', requestId, code });
    if (busy) {
      fail('busy');
      return;
    }
    let handle: () => Promise<unknown>;
    if (message.type === 'probe') handle = () => probe(requestId, epoch);
    else if (message.type === 'walk' && isWalkRequest(message))
      handle = () => walk(message, epoch, send);
    else {
      fail(message.type === 'walk' ? 'invalid_request' : 'unsupported_type');
      return;
    }
    // A new probe or walk supersedes a walk still between slices.
    cancelPending();
    busy = true;
    try {
      const reply = await handle();
      if (reply) send(reply);
    } catch (cause) {
      snapshot = undefined;
      fail(cause instanceof MeanProtocolError ? cause.code : 'internal');
    } finally {
      if (epoch === generation) busy = false;
    }
  }

  // Checks before the module await throw synchronously, so those replies leave in the same tick.
  // The probe also warms the lazy walk and adapter modules and runs detection once.
  function probe(requestId: string, epoch: number): Promise<unknown> {
    snapshot = undefined;
    const saved = snapshotPage(requestId);
    if (!saved) throw new MeanProtocolError('unsupported_viewport');
    modules ??= Promise.all([import('./walk.js'), import('../../adapters/detect.js')]);
    return modules.then(([, adapters]) => {
      if (epoch !== generation || disposed) return;
      adapters.detectAdapters({
        projectRoot,
        deadline: performance.now() + ADAPTER_BUDGET_MS,
        truncated: false,
      });
      if (!unchanged(saved)) throw stale();
      snapshot = saved;
      return {
        v: 1,
        type: 'probe.result',
        requestId,
        title: Array.from(saved.title).slice(0, 256).join(''),
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        viewport: saved.viewport,
      };
    });
  }

  // A walk consumes the probe's snapshot; any change between probe and walk is stale.
  function walk(
    request: WalkRequest,
    epoch: number,
    send: (value: unknown) => void,
  ): Promise<unknown> {
    const saved = snapshot;
    snapshot = undefined;
    if (!saved || saved.id !== request.probeId || !unchanged(saved)) throw stale();
    const view = saved.viewport;
    const expectedWidth = (view.width * view.dpr) / request.deviceScale;
    const expectedHeight = (view.height * view.dpr) / request.deviceScale;
    if (
      Math.abs(request.webArea.width - expectedWidth) > 2 ||
      Math.abs(request.webArea.height - expectedHeight) > 2
    )
      throw stale();
    if (!modules) throw stale();
    const started = performance.now();
    return modules.then(([walker, adapters]) => {
      if (epoch !== generation || disposed) return;
      if (!unchanged(saved)) throw stale();
      // Detection keeps its own short budget so a slow page still leaves the first slice room to walk.
      const detection = { projectRoot, deadline: started + ADAPTER_BUDGET_MS, truncated: false };
      const detected = adapters.detectAdapters(detection);
      const context = {
        projectRoot,
        deadline: started + WALK_WALL_MS,
        truncated: detection.truncated,
      };
      const traversal = walker.startWalk(request.requestId, view, detected, context);
      return advance(traversal, saved, epoch, send, started + FIRST_SLICE_MS - PART_RESERVE_MS);
    });
  }

  // Runs one slice and hands back its part; a zero-delay timer continues the traversal.
  // A snapshot change before the first part is stale; after it, the walk closes with a final part.
  function advance(
    traversal: Traversal,
    saved: Snapshot,
    epoch: number,
    send: (value: unknown) => void,
    deadline: number,
  ): WalkPart {
    const part = traversal.slice(deadline);
    if (!unchanged(saved)) {
      if (part.part === 1) throw stale();
      if (part.more) traversal.cancel();
      return { ...part, elements: [], more: false, truncated: true };
    }
    if (part.more) {
      const timer = setTimeout(() => {
        pending = undefined;
        if (disposed || epoch !== generation) return;
        try {
          if (!unchanged(saved)) {
            send(traversal.cancel());
            return;
          }
          send(
            advance(
              traversal,
              saved,
              epoch,
              send,
              performance.now() + NEXT_SLICE_MS - PART_RESERVE_MS,
            ),
          );
        } catch (cause) {
          send({
            v: 1,
            type: 'error',
            requestId: traversal.requestId,
            code: cause instanceof MeanProtocolError ? cause.code : 'internal',
          });
        }
      }, 0);
      pending = { traversal, timer, send };
    }
    return part;
  }

  const pagehide = (): void => {
    hidden = true;
    cancelPending();
    snapshot = undefined;
    busy = false;
    generation++;
    socket?.close();
    socket = undefined;
  };
  const pageshow = (): void => {
    hidden = false;
    reconnect();
  };
  const visibility = (): void => {
    if (document.visibilityState === 'visible') reconnect();
  };
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', pageshow);
  document.addEventListener('visibilitychange', visibility);
  reconnect();
  return {
    reconnect,
    dispose() {
      disposed = true;
      pagehide();
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', pageshow);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}

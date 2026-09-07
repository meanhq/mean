import {
  type ErrorCode,
  isWalkRequest,
  MeanProtocolError,
  type WalkRequest,
} from '../../protocol/requests.js';
import { isRecord, isUuid, utf8Length } from '../../protocol/validation.js';
import { readViewport, type Viewport } from './viewport.js';

const PAGE_PATH = '/__mean/dom/v1';
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const CONTROL_LIMIT = 4096;
const ADAPTER_BUDGET_MS = 16;

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
    else if (message.type === 'walk' && isWalkRequest(message)) handle = () => walk(message, epoch);
    else {
      fail(message.type === 'walk' ? 'invalid_request' : 'unsupported_type');
      return;
    }
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
  function walk(request: WalkRequest, epoch: number): Promise<unknown> {
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
    return modules.then(([walker, adapters]) => {
      if (epoch !== generation || disposed) return;
      if (!unchanged(saved)) throw stale();
      const context = {
        projectRoot,
        deadline: performance.now() + ADAPTER_BUDGET_MS,
        truncated: false,
      };
      const detected = adapters.detectAdapters(context);
      const result = walker.walk(request.requestId, view, detected, context);
      if (!unchanged(saved)) throw stale();
      return result;
    });
  }

  const pagehide = (): void => {
    hidden = true;
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

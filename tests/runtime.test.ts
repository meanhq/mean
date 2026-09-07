// @vitest-environment jsdom

import Ajv from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRuntime } from '../packages/core/runtime/runtime.js';
import schema from '../packages/protocol/schema/dom.v1.json';

const validate = new Ajv({ strict: false }).compile(schema);
const id = '11111111-1111-1111-1111-111111111111';
const walkId = '22222222-2222-2222-2222-222222222222';
class Socket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  codes: (number | undefined)[] = [];
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    super();
    Socket.instances.push(this);
  }
  send(data: string) {
    const message: unknown = JSON.parse(data);
    expect(validate(message), JSON.stringify(validate.errors)).toBe(true);
    this.sent.push(message as Record<string, unknown>);
  }
  close(code?: number) {
    this.codes.push(code);
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  message(data: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }),
    );
  }
}
function connected(): Socket {
  const socket = Socket.instances[0];
  if (!socket) throw new Error('Expected a connected socket');
  return socket;
}
let runtime: ReturnType<typeof startRuntime> | undefined;
beforeEach(() => {
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { scale: 1, offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight },
  });
  document.body.innerHTML = '';
});
afterEach(() => {
  runtime?.dispose();
  runtime = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const probe = async (socket: Socket) => {
  socket.message({ v: 1, type: 'probe', requestId: id });
  await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe('probe.result'));
};
const walk = () => ({
  v: 1,
  type: 'walk',
  requestId: walkId,
  probeId: id,
  deviceScale: devicePixelRatio,
  webArea: { x: 0, y: 0, width: innerWidth, height: innerHeight },
});
describe('Lifecycle and the idle guarantee', () => {
  it('opens one socket and nothing else while idle', () => {
    const timer = vi.spyOn(window, 'setTimeout');
    const interval = vi.spyOn(window, 'setInterval');
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    const observer = vi.spyOn(window, 'MutationObserver');
    const traversal = vi.spyOn(document, 'createTreeWalker');
    runtime = startRuntime('page-token', '/project');
    expect(Socket.instances).toHaveLength(1);
    expect(Socket.instances[0]?.url).toMatch(/^ws:\/\/localhost(?::\d+)?\/__mean\/dom\/v1$/);
    expect(Socket.instances[0]?.protocols).toEqual(['mean-dom-v1', 'page-token']);
    expect(Socket.instances[0]?.sent).toEqual([]);
    for (const spy of [timer, interval, frames, observer, traversal])
      expect(spy).not.toHaveBeenCalled();
    runtime.reconnect();
    expect(Socket.instances).toHaveLength(1);
    connected().close();
    expect(Socket.instances).toHaveLength(1);
    window.dispatchEvent(new Event('pageshow'));
    expect(Socket.instances).toHaveLength(2);
    runtime.dispose();
    window.dispatchEvent(new Event('pageshow'));
    expect(Socket.instances).toHaveLength(2);
  });
  it('cuts the title at 256 code points and rejects stale and reused probes', async () => {
    document.title = '\u{1f600}'.repeat(257);
    runtime = startRuntime('token', '/project');
    const socket = connected();
    await probe(socket);
    expect(Array.from(String(socket.sent[0]?.title))).toHaveLength(256);
    document.title = 'changed';
    socket.message(walk());
    await vi.waitFor(() => expect(socket.sent.at(-1)?.code).toBe('stale'));
    await probe(socket);
    socket.message(walk());
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe('walk.result'));
    socket.message(walk());
    expect(socket.sent.at(-1)?.code).toBe('stale');
  });
  it('answers busy, unsupported_type and invalid_request and closes malformed JSON', async () => {
    runtime = startRuntime('token', '/project');
    const socket = connected();
    socket.message({ v: 1, type: 'probe', requestId: id });
    socket.message({ v: 1, type: 'probe', requestId: walkId });
    expect(socket.sent.at(-1)?.code).toBe('busy');
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe('probe.result'));
    socket.message({ v: 1, type: 'mystery', requestId: id });
    expect(socket.sent.at(-1)?.code).toBe('unsupported_type');
    socket.message({ ...walk(), deviceScale: 0 });
    expect(socket.sent.at(-1)?.code).toBe('invalid_request');
    socket.message('{');
    expect(socket.codes).toContain(1007);
  });
  it('closes binary, oversized and wrong-version frames with the protocol codes', () => {
    for (const [data, code] of [
      [new Blob(['binary']), 1003],
      ['x'.repeat(4097), 1009],
      [JSON.stringify({ v: 2 }), 1002],
    ] as const) {
      runtime = startRuntime('token', '/project');
      const socket = Socket.instances.at(-1);
      if (!socket) throw new Error('Expected socket');
      socket.dispatchEvent(new MessageEvent('message', { data }));
      expect(socket.codes).toContain(code);
      runtime.dispose();
    }
  });
  it('reports stale when the page changes mid-walk and sends nothing from the snapshot', async () => {
    runtime = startRuntime('token', '/project');
    const socket = connected();
    await probe(socket);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => {
      document.title = 'PRIVATE CHANGE';
      return new DOMRect(0, 0, 10, 10);
    });
    socket.message(walk());
    await vi.waitFor(() => expect(socket.sent.at(-1)?.code).toBe('stale'));
    expect(JSON.stringify(socket.sent.at(-1))).not.toContain('PRIVATE');
  });
  it('reports unsupported_viewport when visualViewport is missing', async () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    runtime = startRuntime('token', '/project');
    connected().message({ v: 1, type: 'probe', requestId: id });
    expect(connected().sent.at(-1)?.code).toBe('unsupported_viewport');
  });
});

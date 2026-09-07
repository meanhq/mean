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
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 100, 100),
  );
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [new DOMRect(0, 0, 100, 100)],
  });
});
afterEach(() => {
  Reflect.deleteProperty(Range.prototype, 'getClientRects');
  runtime?.dispose();
  runtime = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const probe = async (socket: Socket) => {
  socket.message({ v: 1, type: 'probe', requestId: id });
  await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe('probe.result'));
};
// Lets a test run the runtime's zero-delay timers by hand; the runtime must own at most one.
function captureTimers() {
  const queue: (() => void)[] = [];
  const timers = { queue, scheduled: 0, cleared: 0, fire: () => queue.shift()?.() };
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(0);
    timers.scheduled++;
    queue.push(callback);
    return timers.scheduled;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation((() => {
    timers.cleared++;
    queue.length = 0;
  }) as typeof clearTimeout);
  return timers;
}
// Microtasks and one macrotask, outside the captured setTimeout.
const settle = () => new Promise<void>((done) => setImmediate(done));
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
  it('streams a large page in parts on zero-delay timers and holds none after the last', async () => {
    document.body.innerHTML = Array.from(
      { length: 60 },
      (_, index) => `<section><p id="p${index}">${index}</p></section>`,
    ).join('');
    runtime = startRuntime('token', '/project');
    const socket = connected();
    await probe(socket);
    const timers = captureTimers();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 0.1));
    socket.message(walk());
    await settle();
    const parts = () => socket.sent.filter((sent) => sent.requestId === walkId);
    while (parts().at(-1)?.more === true) {
      expect(timers.queue).toHaveLength(1);
      timers.fire();
      await settle();
    }
    expect(parts().length).toBeGreaterThan(2);
    parts().forEach((sent, index) => {
      expect(sent.type).toBe('walk.result');
      expect(sent.part).toBe(index + 1);
      expect(sent.more).toBe(index < parts().length - 1);
      if (index < parts().length - 1) expect(sent.truncated).toBe(false);
    });
    expect(parts().at(-1)?.truncated).toBe(false);
    const ids = parts().flatMap((sent) =>
      (sent.elements as Array<{ id?: string }>).map((element) => element.id),
    );
    for (let index = 0; index < 60; index++) expect(ids).toContain(`p${index}`);
    expect(timers.scheduled).toBe(parts().length - 1);
    expect(timers.queue).toHaveLength(0);
    expect(timers.cleared).toBe(0);
  });
  it('closes a pending walk with a final part when a probe, walk or pagehide interrupts it', async () => {
    document.body.innerHTML = '<p>text</p>'.repeat(60);
    runtime = startRuntime('token', '/project');
    const socket = connected();
    await probe(socket);
    const timers = captureTimers();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 0.1));
    socket.message(walk());
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({ requestId: walkId, part: 1, more: true });
    expect(timers.queue).toHaveLength(1);
    socket.message({ v: 1, type: 'probe', requestId: id });
    const final = socket.sent.at(-1);
    expect(final).toMatchObject({
      type: 'walk.result',
      requestId: walkId,
      part: 2,
      more: false,
      truncated: true,
    });
    expect(timers.cleared).toBe(1);
    await settle();
    expect(socket.sent.at(-1)?.type).toBe('probe.result');
    expect(timers.queue).toHaveLength(0);
    expect(socket.sent.filter((sent) => sent.requestId === walkId).at(-1)).toBe(final);

    socket.message(walk());
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({ requestId: walkId, more: true });
    const secondWalk = '33333333-3333-3333-3333-333333333333';
    socket.message({ ...walk(), requestId: secondWalk });
    expect(socket.sent.at(-2)).toMatchObject({ requestId: walkId, more: false, truncated: true });
    // The interrupted walk consumed the probe, so the newcomer needs a probe of its own.
    expect(socket.sent.at(-1)).toMatchObject({ requestId: secondWalk, code: 'stale' });
    expect(timers.queue).toHaveLength(0);

    socket.message({ v: 1, type: 'probe', requestId: id });
    await settle();
    expect(socket.sent.at(-1)?.type).toBe('probe.result');
    socket.message({ ...walk(), requestId: secondWalk });
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({ requestId: secondWalk, more: true });
    window.dispatchEvent(new Event('pagehide'));
    expect(socket.sent.at(-1)).toMatchObject({
      requestId: secondWalk,
      more: false,
      truncated: true,
    });
    expect(timers.queue).toHaveLength(0);
    expect(timers.cleared).toBe(3);
  });
  it('closes a walk with a final truncated part when the page changes after its first part', async () => {
    document.body.innerHTML = '<p>text</p>'.repeat(60);
    runtime = startRuntime('token', '/project');
    const socket = connected();
    await probe(socket);
    const timers = captureTimers();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 0.1));
    socket.message(walk());
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({ requestId: walkId, part: 1, more: true });
    window.scrollY = 40;
    timers.fire();
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'walk.result',
      requestId: walkId,
      part: 2,
      more: false,
      truncated: true,
    });
    expect(socket.sent.some((sent) => sent.requestId === walkId && sent.type === 'error')).toBe(
      false,
    );
    expect(timers.queue).toHaveLength(0);
  });
  it('drops a pending walk silently when its socket closes', async () => {
    document.body.innerHTML = '<p>text</p>'.repeat(60);
    runtime = startRuntime('token', '/project');
    const socket = connected();
    await probe(socket);
    const timers = captureTimers();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 0.1));
    socket.message(walk());
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({ requestId: walkId, part: 1, more: true });
    const sent = socket.sent.length;
    socket.close();
    expect(timers.cleared).toBe(1);
    expect(timers.queue).toHaveLength(0);
    expect(socket.sent.length).toBe(sent);
  });
  it('reports unsupported_viewport when visualViewport is missing', async () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    runtime = startRuntime('token', '/project');
    connected().message({ v: 1, type: 'probe', requestId: id });
    expect(connected().sent.at(-1)?.code).toBe('unsupported_viewport');
  });
});

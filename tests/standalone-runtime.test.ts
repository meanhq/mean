// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRuntime } from '../packages/core/runtime/runtime.js';

afterEach(() => vi.unstubAllGlobals());
describe('Transport and discovery: standalone socket origin', () => {
  it('uses the supplied loopback origin without changing the page and rejects other origins', () => {
    const Socket = vi.fn(() => ({ addEventListener: vi.fn(), close: vi.fn() }));
    vi.stubGlobal('WebSocket', Socket);
    const origin = location.origin;
    for (const invalid of [
      'https://example.com',
      'http://0.0.0.0:8000',
      'null',
      'bad',
      'http://localhost:8000/path',
      'http://user@localhost:8000',
    ]) {
      startRuntime('token', '', invalid).dispose();
    }
    expect(Socket).not.toHaveBeenCalled();
    startRuntime('token', '', 'https://localhost:9000').dispose();
    expect(Socket).toHaveBeenCalledWith('wss://localhost:9000/__mean/dom/v1', [
      'mean-dom-v1',
      'token',
    ]);
    expect(location.origin).toBe(origin);
  });
});

import Ajv from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import schema from '../packages/protocol/schema/dom.v1.json';

const ajv = new Ajv({ strict: false });
const page = ajv.compile(schema);
const relay = ajv.compile({ $ref: `${schema.$id}#/$defs/relay` });
const requestId = '01234567-0123-4123-8123-0123456789ab';

describe('Wire schema', () => {
  it('ships a draft 2020-12 schema for protocol version 1', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://mean.app/schemas/dom/v1.json');
    expect(ajv.validateSchema(schema)).toBe(true);
  });
  it('accepts every page message and relay envelope form', () => {
    const viewport = { width: 100, height: 100, dpr: 1 };
    for (const message of [
      { v: 1, type: 'probe', requestId },
      { v: 1, type: 'probe.result', requestId, title: '', visible: true, focused: false, viewport },
      {
        v: 1,
        type: 'walk',
        requestId,
        probeId: requestId,
        webArea: { x: -100, y: 0, width: 100, height: 100 },
        deviceScale: 1,
      },
      { v: 1, type: 'walk.result', requestId, viewport, elements: [], truncated: false },
      {
        v: 1,
        type: 'walk.result',
        requestId,
        viewport,
        elements: [],
        truncated: false,
        part: 1,
        more: true,
      },
      { v: 1, type: 'error', requestId, code: 'stale' },
    ]) {
      expect(page(message), JSON.stringify(page.errors)).toBe(true);
      expect(
        relay({ v: 1, type: 'page.message', pageId: requestId, message }),
        JSON.stringify(relay.errors),
      ).toBe(true);
    }
    expect(
      relay({ v: 1, type: 'page.open', pageId: requestId, origin: 'http://localhost:5173' }),
    ).toBe(true);
    expect(relay({ v: 1, type: 'page.close', pageId: requestId })).toBe(true);
  });
  it('numbers walk parts from 1 to 1000', () => {
    const viewport = { width: 100, height: 100, dpr: 1 };
    const result = {
      v: 1,
      type: 'walk.result',
      requestId,
      viewport,
      elements: [],
      truncated: false,
    };
    for (const part of [0, 1001, 1.5, '1'])
      expect(page({ ...result, part, more: false })).toBe(false);
    expect(page({ ...result, part: 1000, more: 'yes' })).toBe(false);
    expect(page({ ...result, part: 1000, more: false })).toBe(true);
  });
});

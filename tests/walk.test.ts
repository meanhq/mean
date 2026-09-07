// @vitest-environment jsdom

import Ajv from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { walk } from '../packages/core/runtime/walk.js';
import schema from '../packages/protocol/schema/dom.v1.json';

const validate = new Ajv({ strict: false }).compile(schema);
const id = '11111111-1111-1111-1111-111111111111';
const rect = (x = 0, y = 0, width = 100, height = 100): DOMRect => ({
  x,
  y,
  width,
  height,
  left: x,
  top: y,
  right: x + width,
  bottom: y + height,
  toJSON() {
    return {};
  },
});
const run = () => {
  const result = walk(id, { width: 1000, height: 1000, dpr: 1 }, [], {
    projectRoot: '',
    deadline: Infinity,
    truncated: false,
  });
  expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  return result;
};
beforeEach(() => {
  document.body.innerHTML = '';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.id === 'small' ? rect(0, 0, 10, 10) : rect();
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [rect()],
  });
  vi.stubGlobal('CSS', { escape: (value: string) => value });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('Walk algorithm and budget', () => {
  it('keeps static HTML source independently of component and framework metadata', () => {
    const button = document.createElement('button');
    button.setAttribute(
      'data-mean-source',
      JSON.stringify({ file: 'index.html', line: 7, column: 5 }),
    );
    document.body.append(button);
    const entry = run().elements.find((element) => element.tag === 'button');
    expect(entry?.source).toEqual({ file: 'index.html', line: 7, column: 5 });
    expect(entry?.framework).toBe('dom');
    expect(entry?.component).toBeUndefined();
    expect(entry?.chain).toBeUndefined();
  });
  it('skips private content, keeps direct text and orders by depth then area', () => {
    document.body.innerHTML =
      '<main>Direct <span id="small">Child</span><input value="SECRET"><input type="password" id="password"><textarea>SECRET</textarea><select><option>SECRET</option></select><div contenteditable><span>SECRET</span></div><div hidden>SECRET</div><script>SECRET</script></main>';
    const result = run();
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result.elements.some((entry) => entry.id === 'password')).toBe(false);
    expect(result.elements.find((entry) => entry.tag === 'main')?.text).toBe('Direct');
    const peers = result.elements.filter((entry) => entry.depth === 3);
    expect(peers[0]?.id).toBe('small');
    expect(result.elements.at(-1)?.tag).toBe('html');
  });
  it('keeps a private host rectangle without reading its descendants', () => {
    document.body.innerHTML =
      '<div id="editable" contenteditable><span id="private"></span></div><select id="control"><option id="private-option"></option></select><textarea id="textarea">SECRET</textarea>';
    const privateRead = vi.fn(() => {
      throw new Error('Private descendant read');
    });
    for (const element of document.querySelectorAll('#private, #private-option'))
      Object.defineProperty(element, 'classList', { get: privateRead });
    for (const element of document.querySelectorAll('#editable, #control, #textarea'))
      Object.defineProperty(element, 'firstChild', { get: privateRead });
    const result = run();
    expect(privateRead).not.toHaveBeenCalled();
    expect(result.elements.some((entry) => entry.id === 'editable')).toBe(true);
    expect(result.elements.some((entry) => entry.id === 'control')).toBe(true);
    expect(result.elements.some((entry) => entry.id?.startsWith('private'))).toBe(false);
  });
  it('keeps children of inline overflow and visible overrides inside hidden ancestors', () => {
    document.body.innerHTML =
      '<span style="display:inline;overflow:hidden"><b id="inline">Visible</b></span><div style="visibility:hidden"><b id="override" style="visibility:visible">Visible</b></div>';
    const result = run();
    expect(result.elements.some((entry) => entry.id === 'inline')).toBe(true);
    expect(result.elements.some((entry) => entry.id === 'override')).toBe(true);
    expect(result.elements.some((entry) => entry.tag === 'div')).toBe(false);
  });
  it('visits onscreen children of offscreen parents and stays out of shadow roots', () => {
    document.body.innerHTML =
      '<div id="off"><span id="small">Visible</span></div><div id="host"></div>';
    const offscreen = document.getElementById('off');
    const host = document.getElementById('host');
    if (!offscreen || !host) throw new Error('Missing test elements');
    vi.spyOn(offscreen, 'getBoundingClientRect').mockReturnValue(rect(-1000, -1000));
    host.attachShadow({ mode: 'open' }).innerHTML = '<b>SHADOW</b>';
    const result = run();
    expect(result.elements.some((entry) => entry.id === 'small')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SHADOW');
  });
  it('counts hidden siblings in nth-of-type', () => {
    document.body.innerHTML = '<div hidden></div><div id="small"></div>';
    expect(run().elements.find((entry) => entry.id === 'small')?.elementPath).toContain(
      'div#small:nth-of-type(2)',
    );
  });
  it('caps element count, depth and field sizes', () => {
    document.body.innerHTML = `<div>${'<b>word</b>'.repeat(1100)}</div>`;
    const result = run();
    expect(result.elements).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(256 * 1024);
    document.body.innerHTML = `${'<div>'.repeat(140)}deep${'</div>'.repeat(140)}`;
    expect(Math.max(...run().elements.map((entry) => entry.depth))).toBe(128);
    document.body.innerHTML = `<div id="${'x'.repeat(129)}">${'\u{1f600}'.repeat(81)}</div>`;
    const last = run();
    expect(last.elements[0]?.id).toBeUndefined();
    expect(Array.from(last.elements[0]?.text || '')).toHaveLength(80);
    expect(last.truncated).toBe(true);
    document.body.innerHTML = `<b>${' '.repeat(2047)}\u{1f600}Visible</b>`;
    expect(run().elements[0]?.text).toBe('\u{1f600}Visible');
  });
  it('clips to rectangular ancestors and omits subtrees with unsupported clips', () => {
    document.body.innerHTML =
      '<div id="clip" style="overflow:hidden"><b id="small">Visible</b></div><div style="clip-path:circle(50%)"><b>UNSUPPORTED</b></div>';
    const clip = document.getElementById('clip');
    if (!clip) throw new Error('Missing clipping element');
    Object.defineProperties(clip, { clientWidth: { value: 5 }, clientHeight: { value: 5 } });
    const result = run();
    expect(result.elements.find((entry) => entry.id === 'small')?.rect).toEqual({
      x: 0,
      y: 0,
      width: 0.005,
      height: 0.005,
    });
    expect(JSON.stringify(result)).not.toContain('UNSUPPORTED');
  });
  it('stops at 10000 visited nodes and 256 KiB of UTF-8', () => {
    document.body.innerHTML = `${'<!-- ignored -->'.repeat(10001)}<b>TOO LATE</b>`;
    const visited = run();
    expect(visited.truncated).toBe(true);
    expect(JSON.stringify(visited)).not.toContain('TOO LATE');
    const classes = Array.from(
      { length: 16 },
      (_, index) => `class${index}${'x'.repeat(120)}`,
    ).join(' ');
    document.body.innerHTML = `<b class="${classes}">text</b>`.repeat(300);
    const bytes = run();
    expect(bytes.truncated).toBe(true);
    expect(bytes.elements.length).toBeLessThan(300);
    expect(new TextEncoder().encode(JSON.stringify(bytes)).length).toBeLessThanOrEqual(256 * 1024);
  });
  it('returns an empty truncated result when the deadline has already passed', () => {
    expect(
      walk(id, { width: 1, height: 1, dpr: 1 }, [], {
        projectRoot: '',
        deadline: -1,
        truncated: false,
      }),
    ).toMatchObject({ elements: [], truncated: true });
  });
});

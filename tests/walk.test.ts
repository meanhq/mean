// @vitest-environment jsdom

import Ajv from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Entry, startWalk, type WalkPart } from '../packages/core/runtime/walk.js';
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
const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const start = (deadline = Infinity) =>
  startWalk(id, { width: 1000, height: 1000, dpr: 1 }, [], {
    projectRoot: '',
    deadline,
    truncated: false,
  });
const checkPart = (part: WalkPart, number: number) => {
  expect(validate(part), JSON.stringify(validate.errors)).toBe(true);
  expect(part.part).toBe(number);
  expect(utf8(part)).toBeLessThanOrEqual(256 * 1024);
  if (part.more) expect(part.truncated).toBe(false);
  const order = part.elements.map((entry) => [entry.depth, entry.rect.width * entry.rect.height]);
  for (let index = 1; index < order.length; index++) {
    const [previousDepth = 0, previousArea = 0] = order[index - 1] ?? [];
    const [depth = 0, area = 0] = order[index] ?? [];
    expect(previousDepth > depth || (previousDepth === depth && previousArea <= area)).toBe(true);
  }
};
// Drains a whole walk with a per-slice budget, checking every part on the way.
const run = (sliceBudget = Infinity, deadline = Infinity) => {
  const traversal = start(deadline);
  const parts: WalkPart[] = [];
  const elements: Entry[] = [];
  for (;;) {
    const part = traversal.slice(performance.now() + sliceBudget);
    checkPart(part, parts.length + 1);
    parts.push(part);
    elements.push(...part.elements);
    if (!part.more) break;
  }
  const last = parts.at(-1);
  if (!last) throw new Error('A walk has at least one part');
  return {
    elements,
    truncated: last.truncated,
    parts,
    bytes: parts.reduce((n, p) => n + utf8(p), 0),
  };
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
    expect(JSON.stringify(result.parts)).not.toContain('SECRET');
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
    expect(JSON.stringify(result.parts)).not.toContain('SHADOW');
  });
  it('counts hidden siblings in nth-of-type', () => {
    document.body.innerHTML = '<div hidden></div><div id="small"></div>';
    expect(run().elements.find((entry) => entry.id === 'small')?.elementPath).toContain(
      'div#small:nth-of-type(2)',
    );
  });
  it('serializes a part byte for byte like JSON.stringify', () => {
    document.body.innerHTML = '<main id="a"><b class="x y">Hi \u{1f600}</b><i>there</i></main>';
    const traversal = start(Infinity);
    const part = traversal.slice(Infinity);
    expect(traversal.serialize(part)).toBe(JSON.stringify(part));
    expect(JSON.parse(traversal.serialize(part))).toEqual(part);
  });
  it('caps element count, depth and field sizes', () => {
    document.body.innerHTML = `<div>${'<b>word</b>'.repeat(4100)}</div>`;
    const result = run();
    expect(result.elements).toHaveLength(4000);
    expect(result.truncated).toBe(true);
    expect(result.parts.length).toBe(4);
    document.body.innerHTML = `${'<div>'.repeat(140)}deep${'</div>'.repeat(140)}`;
    const deep = run();
    expect(Math.max(...deep.elements.map((entry) => entry.depth))).toBe(128);
    // Paths are never cut short: the deepest walked element still names every ancestor.
    const deepest = deep.elements.find((entry) => entry.depth === 128);
    expect(deepest?.elementPath?.split(' > ')).toHaveLength(129);
    document.body.innerHTML = `<div id="${'x'.repeat(129)}">${'\u{1f600}'.repeat(81)}</div>`;
    const last = run();
    expect(last.elements[0]?.id).toBeUndefined();
    expect(Array.from(last.elements[0]?.text || '')).toHaveLength(80);
    expect(last.truncated).toBe(true);
    document.body.innerHTML = `<b>${' '.repeat(2047)}\u{1f600}Visible</b>`;
    expect(run().elements[0]?.text).toBe('\u{1f600}Visible');
  });
  it('clips to rectangular ancestors and omits descendants of unsupported clips', () => {
    document.body.innerHTML =
      '<div id="clip" style="overflow:hidden"><b id="small">Visible</b></div><div style="clip-path:circle(50%)"><b>UNSUPPORTED</b></div><div id="moved" style="overflow:hidden;transform:rotate(3deg)">Moved<b id="inside">TRANSFORMED</b></div>';
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
    expect(JSON.stringify(result.parts)).not.toContain('UNSUPPORTED');
    // The transformed container keeps its own box and text; only its descendants' geometry is unknown.
    expect(result.elements.find((entry) => entry.id === 'moved')?.text).toBe('Moved');
    expect(JSON.stringify(result.parts)).not.toContain('TRANSFORMED');
  });
  it('clips descendants of a rounded overflow container to its padding box inset by the radius', () => {
    document.body.innerHTML =
      '<div id="card" style="overflow:hidden;border-radius:0 8px 8px 0"><b id="badge">Badge</b></div><div id="avatar" style="overflow:hidden;border-radius:50%"><b id="picture">Picture</b></div>';
    for (const id of ['card', 'avatar']) {
      const element = document.getElementById(id);
      if (!element) throw new Error('Missing rounded element');
      Object.defineProperties(element, { clientWidth: { value: 40 }, clientHeight: { value: 40 } });
    }
    const result = run();
    expect(result.elements.find((entry) => entry.id === 'badge')?.rect).toEqual({
      x: 0.008,
      y: 0.008,
      width: 0.024,
      height: 0.024,
    });
    // A 50% radius insets the whole box: nothing inside the circle can be placed.
    expect(result.elements.some((entry) => entry.id === 'avatar')).toBe(true);
    expect(JSON.stringify(result.parts)).not.toContain('Picture');
  });
  it('stops at 40000 visited nodes and 2 MiB of UTF-8 across parts', () => {
    document.body.innerHTML = `${'<!-- ignored -->'.repeat(40001)}<b>TOO LATE</b>`;
    const visited = run();
    expect(visited.truncated).toBe(true);
    expect(JSON.stringify(visited.parts)).not.toContain('TOO LATE');
    const classes = Array.from(
      { length: 16 },
      (_, index) => `class${index}${'x'.repeat(120)}`,
    ).join(' ');
    document.body.innerHTML = `<b class="${classes}">text</b>`.repeat(1100);
    const bytes = run();
    expect(bytes.truncated).toBe(true);
    expect(bytes.elements.length).toBeLessThan(1100);
    expect(bytes.elements.length).toBeGreaterThan(700);
    expect(bytes.parts.length).toBeGreaterThan(4);
    expect(bytes.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
  it('returns an empty truncated result when the deadline has already passed', () => {
    expect(start(-1).slice(Infinity)).toMatchObject({
      elements: [],
      truncated: true,
      part: 1,
      more: false,
    });
  });
  it('yields at the slice deadline, sorts each part on its own and covers every element', () => {
    document.body.innerHTML = Array.from(
      { length: 60 },
      (_, index) => `<section><p id="p${index}">${index}</p></section>`,
    ).join('');
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => ++clock);
    const result = run(4);
    expect(result.parts.length).toBeGreaterThan(5);
    expect(result.parts.every((part, index) => part.more === index < result.parts.length - 1));
    expect(result.truncated).toBe(false);
    const ids = new Set(result.elements.map((entry) => entry.id));
    for (let index = 0; index < 60; index++) expect(ids.has(`p${index}`)).toBe(true);
    expect(result.elements.filter((entry) => entry.tag === 'section')).toHaveLength(60);
    expect(result.elements.filter((entry) => entry.tag === 'body')).toHaveLength(1);
    // The same document in one slice yields the same inventory in a different grouping.
    const whole = run();
    expect(whole.parts).toHaveLength(1);
    expect(whole.elements.map((entry) => entry.elementPath).sort()).toEqual(
      result.elements.map((entry) => entry.elementPath).sort(),
    );
  });
  it('closes at the wall deadline with a final truncated part holding what it inventoried', () => {
    document.body.innerHTML = '<p>text</p>'.repeat(60);
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => ++clock);
    const result = run(8, 40);
    expect(result.parts.length).toBeGreaterThan(1);
    expect(result.truncated).toBe(true);
    expect(result.elements.length).toBeGreaterThan(0);
    expect(result.elements.length).toBeLessThan(60);
  });
  it('closes a cancelled walk with what it holds and refuses to continue', () => {
    document.body.innerHTML = '<b>one</b>'.repeat(20);
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => ++clock);
    const traversal = start();
    const first = traversal.slice(clock + 3);
    checkPart(first, 1);
    expect(first.more).toBe(true);
    const final = traversal.cancel();
    checkPart(final, 2);
    expect(final).toMatchObject({ more: false, truncated: true });
    expect(() => traversal.slice(Infinity)).toThrow();
    expect(() => traversal.cancel()).toThrow();
    const complete = start();
    expect(complete.slice(Infinity).more).toBe(false);
    expect(() => complete.cancel()).toThrow();
  });
});

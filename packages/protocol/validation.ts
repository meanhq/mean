const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isNumberWithin = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

// Counts without allocating; a surrogate pair is one code point, a lone surrogate also counts as one.
export const codePointCount = (value: string): number => {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
};

// A string never has more code points than UTF-16 units, so short strings need no scan.
export const isBoundedString = (value: unknown, maxCodePoints: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  (value.length <= maxCodePoints ||
    (value.length <= maxCodePoints * 2 && codePointCount(value) <= maxCodePoints));

const encoder = new TextEncoder();
export const utf8Length = (text: string): number => encoder.encode(text).byteLength;

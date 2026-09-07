const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isNumberWithin = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export const codePointCount = (value: string): number => Array.from(value).length;

// A UTF-16 length check first so long strings are rejected without a full code point scan.
export const isBoundedString = (value: unknown, maxCodePoints: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxCodePoints * 2 &&
  codePointCount(value) <= maxCodePoints;

export const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength;

import { isNumberWithin, isRecord, isUuid } from './validation.js';

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Probe {
  v: 1;
  type: 'probe';
  requestId: string;
}
export interface WalkRequest {
  v: 1;
  type: 'walk';
  requestId: string;
  probeId: string;
  webArea: ScreenRect;
  deviceScale: number;
}
export type ErrorCode =
  | 'stale'
  | 'busy'
  | 'unsupported_viewport'
  | 'unsupported_type'
  | 'invalid_request'
  | 'internal';

export class MeanProtocolError extends Error {
  override name: string = 'MeanProtocolError';
  constructor(public readonly code: ErrorCode) {
    super(code);
  }
}

export function isWalkRequest(
  value: Record<string, unknown>,
): value is Record<string, unknown> & WalkRequest {
  const area = value.webArea;
  return (
    isUuid(value.requestId) &&
    isUuid(value.probeId) &&
    isNumberWithin(value.deviceScale, Number.MIN_VALUE, 16) &&
    isRecord(area) &&
    isNumberWithin(area.x, -1e6, 1e6) &&
    isNumberWithin(area.y, -1e6, 1e6) &&
    isNumberWithin(area.width, Number.MIN_VALUE, 1e5) &&
    isNumberWithin(area.height, Number.MIN_VALUE, 1e5)
  );
}

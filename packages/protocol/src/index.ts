/* Generated from schema/dom.v1.json. Do not edit. */

export type HttpsMeanAppSchemasDomV1Json = Walk | Result | Probe | ProbeResult | Error;
export type Uuid = string;
export type Name = string;

export interface Walk {
  v: 1;
  type: "walk";
  requestId: Uuid;
  probeId: Uuid;
  webArea: ScreenRect;
  deviceScale: number;
  [k: string]: unknown;
}
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
  [k: string]: unknown;
}
export interface Result {
  v: 1;
  type: "walk.result";
  requestId: Uuid;
  viewport: Viewport;
  /**
   * @maxItems 1000
   */
  elements: Element[];
  truncated: boolean;
  part?: number;
  more?: boolean;
  [k: string]: unknown;
}
export interface Viewport {
  width: number;
  height: number;
  dpr: number;
  [k: string]: unknown;
}
export interface Element {
  rect: Rect;
  tag: string;
  role?: string;
  id?: string;
  /**
   * @maxItems 16
   */
  classes:
    | []
    | [Name]
    | [Name, Name]
    | [Name, Name, Name]
    | [Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name];
  text?: string;
  elementPath?: string;
  component?: Name;
  /**
   * @minItems 1
   * @maxItems 12
   */
  chain?:
    | [Name]
    | [Name, Name]
    | [Name, Name, Name]
    | [Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name]
    | [Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name, Name];
  source?: Source;
  framework: string;
  depth: number;
  [k: string]: unknown;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  [k: string]: unknown;
}
export interface Source {
  file: string;
  line: number;
  column?: number;
  [k: string]: unknown;
}
export interface Probe {
  v: 1;
  type: "probe";
  requestId: Uuid;
  [k: string]: unknown;
}
export interface ProbeResult {
  v: 1;
  type: "probe.result";
  requestId: Uuid;
  title: string;
  visible: boolean;
  focused: boolean;
  viewport: Viewport;
  [k: string]: unknown;
}
export interface Error {
  v: 1;
  type: "error";
  requestId: Uuid;
  code: "stale" | "busy" | "unsupported_viewport" | "unsupported_type" | "invalid_request" | "internal";
  [k: string]: unknown;
}

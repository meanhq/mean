import { isNumberWithin } from '../../protocol/validation.js';

export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}
// V1 supports only an unzoomed, unoffset visual viewport that matches the layout viewport.
export function readViewport(): Viewport | undefined {
  const visual = window.visualViewport;
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
  };
  if (
    visual?.scale !== 1 ||
    visual.offsetLeft !== 0 ||
    visual.offsetTop !== 0 ||
    Math.abs(visual.width - viewport.width) > 1 ||
    Math.abs(visual.height - viewport.height) > 1 ||
    !isNumberWithin(viewport.width, Number.MIN_VALUE, 1e5) ||
    !isNumberWithin(viewport.height, Number.MIN_VALUE, 1e5) ||
    !isNumberWithin(viewport.dpr, Number.MIN_VALUE, 16)
  )
    return;
  return viewport;
}

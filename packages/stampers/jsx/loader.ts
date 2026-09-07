import { stampJSX } from './stamp.js';

interface LoaderContext {
  resourcePath: string;
  getOptions(): unknown;
  callback(error: Error | null, code: string, map?: unknown): void;
}

export default function stampLoader(this: LoaderContext, code: string, inputMap?: unknown): void {
  const options = this.getOptions();
  if (
    typeof options !== 'object' ||
    options === null ||
    !('root' in options) ||
    typeof options.root !== 'string'
  ) {
    this.callback(new Error('Mean JSX loader requires a project root'), code, inputMap);
    return;
  }
  const result = stampJSX(code, this.resourcePath, options.root);
  this.callback(null, result?.code ?? code, result ? JSON.parse(result.map.toString()) : inputMap);
}

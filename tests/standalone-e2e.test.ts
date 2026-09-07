import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
describe('Install and use: standalone Python backend', () => {
  it('walks plain backend markup through the built public CLI and excludes production', async () => {
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', 'fixtures/python/check.ts'],
      { timeout: 60_000 },
    );
    console.info(stdout.trim());
    expect(stdout).toContain('cross-origin modules, schema-valid walk, source and names absent');
    expect(stdout).toContain(
      'Production: script omitted and endpoints unavailable; SIGINT: clean exit',
    );
    expect(stdout).toMatch(/cold page walk p50 \(20 fresh pages\): \d+\.\d{2} ms/);
    expect(stdout).toMatch(/warm page walk p50 \(20 runs\): \d+\.\d{2} ms/);
  }, 70_000);
});

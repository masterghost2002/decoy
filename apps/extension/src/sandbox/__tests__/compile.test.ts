import { describe, expect, it } from 'vitest';

import { compileHandler } from '../compile.js';

/** Runs a compiled handler with the arguments the sandbox would pass. */
async function run(code: string, req: unknown = {}) {
  const compiled = compileHandler(code);
  if (!compiled.ok) throw new Error(compiled.message);
  const store: Record<string, unknown> = {};
  return await compiled.run(req, {}, () => 'next', store, console);
}

describe('compileHandler', () => {
  it('compiles a bare body of statements', async () => {
    await expect(run('return { ok: true };')).resolves.toEqual({ ok: true });
  });

  it('lets a bare body await, which is the form the docs show', async () => {
    // `new Function` builds a synchronous function, so this is only possible
    // through the AsyncFunction constructor. Getting a SyntaxError here for
    // the most ordinary line anyone writes would be a poor first impression.
    await expect(
      run('await new Promise((resolve) => setTimeout(resolve, 1)); return { awaited: true };'),
    ).resolves.toEqual({ awaited: true });
  });

  it('compiles an arrow function expression', async () => {
    await expect(
      run('(req) => ({ form: "arrow", method: req.method })', { method: 'GET' }),
    ).resolves.toEqual({ form: 'arrow', method: 'GET' });
  });

  it('compiles an async arrow function expression', async () => {
    await expect(run('async () => ({ form: "async arrow" })')).resolves.toEqual({
      form: 'async arrow',
    });
  });

  it('strips an export default preamble', async () => {
    await expect(
      run('export default function handler() { return { form: "export default" }; }'),
    ).resolves.toEqual({ form: 'export default' });
  });

  it('strips a module.exports preamble, trailing semicolon and all', async () => {
    // Exactly what gets pasted out of a node project. The semicolon that ended
    // the assignment becomes a syntax error once the remainder is wrapped in
    // parentheses, so it has to go with the preamble.
    await expect(
      run('module.exports = function () { return { form: "module.exports" }; };'),
    ).resolves.toEqual({ form: 'module.exports' });
  });

  it('refuses empty source with an explanation rather than a stack', () => {
    const result = compileHandler('   \n  ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('empty');
  });

  it('names the syntax error rather than swallowing it', () => {
    const result = compileHandler('return {');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('SyntaxError');
  });

  it('rejects an expression that is not a function', () => {
    const result = compileHandler('(1 + 1)');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('did not evaluate to one');
  });
});

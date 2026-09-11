/**
 * Turning the user's text into a callable function.
 *
 * Kept separate from the sandbox page itself so it can be unit-tested in node:
 * the compilation rules are the part people will trip over, and "why does my
 * handler not run?" should be answerable by a test rather than by a browser.
 */

/** The arguments every handler is called with, in order. */
export const HANDLER_ARGS = ['req', 'res', 'next', 'store', 'console'] as const;

export type CompiledHandler = (
  req: unknown,
  res: unknown,
  next: unknown,
  store: unknown,
  logger: unknown,
) => unknown;

export interface CompileFailure {
  ok: false;
  message: string;
}

export interface CompileSuccess {
  ok: true;
  run: CompiledHandler;
}

export type CompileResult = CompileSuccess | CompileFailure;

/**
 * True when the source is one expression that evaluates to a function, rather
 * than a body of statements.
 *
 * Both forms have to work. The documented, shortest form is a bare body --
 * `return res.json(...)` -- and that is what the starter code shows. But
 * everyone who has written a route handler before will paste
 * `export default async function handler(req, res) { ... }`, and greeting that
 * with "SyntaxError: Unexpected token 'export'" teaches nothing about a tool
 * whose whole selling point is that it takes real JavaScript.
 */
function looksLikeFunctionExpression(source: string): boolean {
  return /^(async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(source);
}

const EXPORT_DEFAULT = /^export\s+default\s+/;
const MODULE_EXPORTS = /^module\.exports\s*=\s*/;

/**
 * Compiles the source into something callable, or explains why it will not
 * compile in a sentence that names the problem.
 *
 * `new Function` is the only tool available: the page has no module loader we
 * can reach, and this is a sandboxed document precisely so that building a
 * function from a string is permitted here and nowhere else in the extension.
 */
export function compileHandler(code: string): CompileResult {
  const source = code.trim();
  if (source.length === 0) {
    return { ok: false, message: 'The handler is empty, so it has nothing to answer with.' };
  }

  // A module-ish preamble is stripped rather than rejected; what follows it is
  // the function the user meant to write either way.
  const stripped = source.replace(EXPORT_DEFAULT, '').replace(MODULE_EXPORTS, '').trim();
  const asExpression = looksLikeFunctionExpression(stripped);

  try {
    if (asExpression) {
      // The body evaluates to the user's function, which is then called with
      // the same arguments a bare body would have received. A trailing
      // semicolon after their declaration is harmless inside the parentheses.
      const factory = new Function(`"use strict"; return (${stripped});`) as () => unknown;
      const inner = factory();
      if (typeof inner !== 'function') {
        return {
          ok: false,
          message: 'That looks like a function but did not evaluate to one.',
        };
      }
      const callable = inner as CompiledHandler;
      return {
        ok: true,
        run: (req, res, next, store, logger) => callable(req, res, next, store, logger),
      };
    }

    const run = new Function(...HANDLER_ARGS, `"use strict";\n${source}`) as CompiledHandler;
    return { ok: true, run };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name.length > 0 ? error.name : 'Error';
    return `${name}: ${error.message}`;
  }
  // A handler is free to `throw 'nope'`, and the log still has to say something.
  return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error);
}

/**
 * Formats one `console` argument the way DevTools would, flattened to a string
 * because the real arguments cannot cross a `postMessage` boundary.
 */
export function formatLogArgument(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return describe(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (typeof value === 'undefined') return 'undefined';
  try {
    return JSON.stringify(value, replaceCircular(), 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Keeps a cyclic object from turning a stray `console.log` into a crash. */
function replaceCircular(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value;
  };
}

export interface JsonCheck {
  valid: boolean;
  /** Parser message, for showing next to the editor. */
  error: string | null;
}

/**
 * Reports whether a body parses, without ever rewriting it. Invalid JSON is a
 * legitimate thing to mock, so this only ever informs the UI.
 */
export function checkJson(text: string): JsonCheck {
  if (text.trim().length === 0) return { valid: false, error: 'Body is empty' };
  try {
    JSON.parse(text);
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : 'Invalid JSON' };
  }
}

/** Pretty-prints when possible; returns the input untouched when it does not parse. */
export function formatJson(text: string, indent = 2): string {
  try {
    return JSON.stringify(JSON.parse(text), null, indent);
  } catch {
    return text;
  }
}

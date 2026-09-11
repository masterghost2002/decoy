import type { StreamFormat } from '@decoy/core';

/**
 * The format a loaded file is plainly in, or `null` when it is not plain.
 *
 * This matters more than it looks. The split into chunks is done by the
 * format that is currently selected, so loading an ndjson capture while the
 * rule is set to `sse` produces one enormous chunk containing the whole file --
 * a stream that is technically correct and completely useless. Reading the
 * format off the file first is what makes "load this capture" work in one
 * gesture instead of two, and it only ever fires when the answer is obvious.
 */
export function streamFormatForFile(name: string, text: string): StreamFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) return 'ndjson';
  if (lower.endsWith('.sse')) return 'sse';
  if (lower.endsWith('.txt')) return 'text';

  // Only the head is sniffed: the question is what the first records look like,
  // and a 200KB log does not get more informative further down.
  const lines = text.slice(0, 4096).split('\n');
  const head = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (head.length === 0) return null;

  // An SSE field on the first line is conclusive; nothing else starts that way.
  if (/^(data|event|id|retry):/.test(head[0] ?? '')) return 'sse';

  const sampled = head.slice(0, 5);
  if (sampled.length >= 2 && sampled.every(isJson)) return 'ndjson';

  return null;
}

function isJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

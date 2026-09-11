import type { HeaderPair, MockRule, TrafficEntry } from '@decoy/core';
import { Check, Copy, Wand2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/ui/components/ui/button';
import { Sheet, SheetContent } from '@/ui/components/ui/sheet';
import { MethodPill, OutcomePill, StatusPill } from '@/ui/components/ui/pill';
import { formatClockTime, formatDuration, formatOrdinal } from '@/ui/lib/utils';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => {
              setCopied(false);
            }, 1400);
          },
          () => undefined,
        );
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="eyebrow">
          {title}
          {count !== undefined ? <span className="ml-1.5 text-ink-muted">{count}</span> : null}
        </h3>
        <span aria-hidden className="h-px flex-1 bg-hairline" />
        {action}
      </div>
      {children}
    </section>
  );
}

function HeaderTable({ headers, empty }: { headers: HeaderPair[]; empty: string }) {
  if (headers.length === 0) {
    return <p className="text-[12px] leading-snug text-ink-muted">{empty}</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl bg-surface shadow-ring">
      <table className="w-full table-fixed border-collapse">
        <tbody className="divide-y divide-hairline">
          {headers.map((header, index) => (
            // Header names repeat legitimately (Set-Cookie), so the index is
            // part of the identity here.
            <tr key={`${header.name}-${String(index)}`} className="align-top">
              <th
                scope="row"
                className="w-2/5 break-words px-2.5 py-1.5 text-left font-mono text-[12px] font-medium text-ink-muted"
              >
                {header.name}
              </th>
              <td className="break-words px-2.5 py-1.5 font-mono text-[12px] text-ink">
                {header.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BodyBlock({
  body,
  truncated,
  empty,
}: {
  body: string | null;
  truncated: boolean;
  empty: string;
}) {
  if (body === null || body.length === 0) {
    return <p className="text-[12px] leading-snug text-ink-muted">{empty}</p>;
  }

  // Pretty-print JSON for reading; the raw text stays available through Copy.
  let display = body;
  try {
    display = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Not JSON, or deliberately malformed. Show it exactly as sent.
  }

  return (
    <>
      <pre className="max-h-80 overflow-auto rounded-xl bg-sunk p-2.5 font-mono text-[12px] leading-relaxed text-ink shadow-ring">
        {display}
      </pre>
      {truncated ? (
        <p className="text-[12px] leading-snug text-warn">
          Truncated at 64 kB for capture. The real one was not.
        </p>
      ) : null}
    </>
  );
}

export interface TrafficDetailProps {
  entry: TrafficEntry | null;
  /** So the deciding rule can be named by its current position, not just by name. */
  rules: MockRule[];
  onClose: () => void;
  onMockRequest: (entry: TrafficEntry) => void;
}

/** The full "why did this happen" sentence, which the row only has room to abbreviate. */
function decidedBy(entry: TrafficEntry, rules: MockRule[]): string {
  if (entry.ruleId === null) {
    return 'No rule matched, so this reached the real network.';
  }

  const index = rules.findIndex((rule) => rule.id === entry.ruleId);
  const name = entry.ruleName ?? 'a rule that has since been deleted';
  if (index === -1) {
    return `Decided by \u201c${name}\u201d, which is no longer in the list.`;
  }
  return `Decided by rule ${formatOrdinal(index)}, \u201c${name}\u201d \u2014 the first enabled rule that matched.`;
}

/**
 * Everything the page could tell us about one request. This is where "what did
 * my app actually send?" gets answered, which is the question that otherwise
 * sends people back to the DevTools network panel.
 */
export function TrafficDetail({ entry, rules, onClose, onMockRequest }: TrafficDetailProps) {
  return (
    <Sheet
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {entry !== null ? (
        <SheetContent
          title="Request detail"
          toolbar={
            <div className="flex items-center gap-1.5">
              <MethodPill method={entry.method} />
              <StatusPill status={entry.status} />
              <OutcomePill outcome={entry.outcome} />
            </div>
          }
          footer={
            <>
              <span className="eyebrow tabular">
                {formatClockTime(entry.startedAt)} · {formatDuration(entry.durationMs)} ·{' '}
                {entry.transport}
              </span>
              <Button
                size="sm"
                variant="primary"
                className="ml-auto"
                onClick={() => {
                  onMockRequest(entry);
                  onClose();
                }}
              >
                <Wand2 />
                Mock this request
              </Button>
            </>
          }
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3.5">
            <Section title="Url" action={<CopyButton text={entry.url} label="Copy the url" />}>
              <p className="rounded-xl bg-sunk p-2.5 font-mono text-[12px] leading-relaxed break-all text-ink shadow-ring">
                {entry.url}
              </p>
              <p className="text-[12.5px] leading-snug text-ink-muted">{decidedBy(entry, rules)}</p>
            </Section>

            <Section
              title="Request payload"
              action={
                entry.requestBody !== null && entry.requestBody.length > 0 ? (
                  <CopyButton text={entry.requestBody} label="Copy the request payload" />
                ) : undefined
              }
            >
              <BodyBlock
                body={entry.requestBody}
                truncated={entry.requestBodyTruncated}
                empty="No payload was sent with this request."
              />
            </Section>

            <Section title="Request headers" count={entry.requestHeaders.length}>
              <HeaderTable
                headers={entry.requestHeaders}
                empty="No headers were set explicitly. The browser adds its own, which a page cannot read back."
              />
            </Section>

            <Section
              title="Response body"
              action={
                entry.responseBody !== null && entry.responseBody.length > 0 ? (
                  <CopyButton text={entry.responseBody} label="Copy the response body" />
                ) : undefined
              }
            >
              <BodyBlock
                body={entry.responseBody}
                truncated={entry.responseBodyTruncated}
                empty={
                  entry.outcome === 'failed'
                    ? 'The request failed, so there was no response body.'
                    : 'Not captured — the response was binary, opaque, or empty. Mock this will start you with an empty object.'
                }
              />
            </Section>

            <Section title="Response headers" count={entry.responseHeaders.length}>
              <HeaderTable
                headers={entry.responseHeaders}
                empty={
                  entry.outcome === 'failed'
                    ? 'The request failed, so there was no response to read headers from.'
                    : 'No readable response headers. A cross-origin response only exposes the CORS-safelisted ones.'
                }
              />
            </Section>
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

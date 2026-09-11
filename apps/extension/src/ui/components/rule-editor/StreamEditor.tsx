import {
  MAX_CHUNKS_FROM_TEXT,
  STREAM_FORMATS,
  chunksFromText,
  createStreamChunk,
  encodeStreamChunk,
  type StreamChunk,
  type StreamFormat,
} from '@decoy/core';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';

import { Button } from '@/ui/components/ui/button';
import { Field, Label } from '@/ui/components/ui/field';
import { FileLoader, dropRing, useFileDrop, type LoadedFile } from '@/ui/components/ui/file-loader';
import { Input, Textarea } from '@/ui/components/ui/input';
import { Listbox, type ListboxOption } from '@/ui/components/ui/listbox';
import { useToast } from '@/ui/components/ui/toast';
import { Tooltip } from '@/ui/components/ui/tooltip';
import { streamFormatForFile } from '@/ui/lib/stream-file';
import { cn } from '@/ui/lib/utils';

const FORMAT_DESCRIPTIONS: Record<StreamFormat, ReactNode> = {
  sse: 'Server-sent events',
  ndjson: 'One json record per line',
  text: 'Raw text, no framing',
};

const FORMAT_OPTIONS: Array<ListboxOption<StreamFormat>> = STREAM_FORMATS.map((value) => ({
  value,
  label: value,
  description: FORMAT_DESCRIPTIONS[value],
}));

const FORMAT_HINTS: Record<StreamFormat, string> = {
  sse: 'Sent as text/event-stream. A chunk that does not already name an SSE field gets a data: prefix and the blank line that ends an event.',
  ndjson:
    'Sent as application/x-ndjson, one record per line. Pretty-printed json is compacted onto a single line; anything that is not json goes as written.',
  text: 'Sent as text/plain, exactly as written, with nothing inserted between chunks.',
};

export interface StreamEditorProps {
  format: StreamFormat;
  chunks: StreamChunk[];
  intervalMs: number;
  repeat: number;
  onChangeFormat: (next: StreamFormat) => void;
  onChangeChunks: (next: StreamChunk[]) => void;
  onChangeInterval: (next: number) => void;
  onChangeRepeat: (next: number) => void;
}

/**
 * The pieces a streamed body arrives in, and the pace they arrive at.
 *
 * The chunk list is the whole model, and it is deliberately literal: one box per
 * thing that lands on the wire, in the order it lands. Framing is the format's
 * job, not the user's -- writing `data:` and the trailing blank line by hand for
 * forty SSE events is how people get event streams subtly wrong -- so each box
 * shows what it will actually become underneath it.
 */
export function StreamEditor({
  format,
  chunks,
  intervalMs,
  repeat,
  onChangeFormat,
  onChangeChunks,
  onChangeInterval,
  onChangeRepeat,
}: StreamEditorProps) {
  const toast = useToast();

  /**
   * A file *is* the stream, so it replaces the chunk list rather than being
   * appended to whatever was already there -- playing a capture back with two
   * leftover sample chunks in front of it is not playing the capture back.
   * Replacing is destructive, so it is undoable, which is the same bargain the
   * rule list makes for deletion.
   */
  const loadFile = (file: LoadedFile) => {
    // The file's own format wins, when it has one: the split is done by format,
    // and splitting an ndjson capture as sse yields one chunk holding the whole
    // file. Silent would be wrong, so the toast names the format it used.
    const detected = streamFormatForFile(file.name, file.text);
    const using = detected ?? format;
    const result = chunksFromText(using, file.text);

    if (result.chunks.length === 0) {
      toast.show(`${file.name} has nothing to send: no lines, or only blank ones.`);
      return;
    }

    const previousChunks = chunks;
    const previousFormat = format;
    if (detected !== null && detected !== format) onChangeFormat(detected);
    onChangeChunks(result.chunks);

    const notes: string[] = [];
    if (detected !== null && detected !== previousFormat) notes.push(`as ${detected}`);
    if (result.truncated) notes.push('cut at 256KB');
    if (result.omitted > 0)
      notes.push(
        `${String(result.omitted)} past the first ${String(MAX_CHUNKS_FROM_TEXT)} left out`,
      );

    toast.show(
      `${String(result.chunks.length)} ${result.chunks.length === 1 ? 'chunk' : 'chunks'} from ${file.name}${notes.length === 0 ? '' : ` (${notes.join(', ')})`}`,
      {
        label: 'Undo',
        onAct: () => {
          onChangeChunks(previousChunks);
          onChangeFormat(previousFormat);
        },
      },
    );
  };

  const drop = useFileDrop(loadFile, (message) => {
    toast.show(message);
  });

  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= chunks.length) return;
    const next = [...chunks];
    const [moved] = next.splice(index, 1);
    if (moved !== undefined) next.splice(target, 0, moved);
    onChangeChunks(next);
  };

  const total = useMemo(() => {
    if (chunks.length === 0) return 0;
    if (repeat === 0) return Number.POSITIVE_INFINITY;
    return intervalMs * (chunks.length * repeat - 1);
  }, [chunks.length, intervalMs, repeat]);

  return (
    <>
      <div className="flex flex-wrap gap-2.5">
        <Field
          label="Format"
          hint={FORMAT_HINTS[format]}
          className="min-w-[12rem] max-w-[24rem] flex-1"
        >
          {(id) => (
            <Listbox
              id={id}
              value={format}
              options={FORMAT_OPTIONS}
              onChange={onChangeFormat}
              ariaLabel="Stream format"
            />
          )}
        </Field>

        <Field label="Every (ms)" className="w-24">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              value={intervalMs}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                onChangeInterval(Number.isNaN(parsed) ? 0 : Math.max(0, parsed));
              }}
              className="tabular font-mono"
            />
          )}
        </Field>

        <Field label="Repeat" className="w-24">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={0}
              value={repeat}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                onChangeRepeat(Number.isNaN(parsed) ? 0 : Math.max(0, parsed));
              }}
              className="tabular font-mono"
            />
          )}
        </Field>
      </div>

      <p className="helper max-w-[62ch]">
        {chunks.length === 0
          ? 'No chunks yet, so the response has no body at all.'
          : repeat === 0
            ? `The ${String(chunks.length)} ${chunks.length === 1 ? 'chunk' : 'chunks'} repeat forever, one every ${String(intervalMs)}ms. The stream never closes — set a repeat count to end it.`
            : `${String(chunks.length * repeat)} ${chunks.length * repeat === 1 ? 'chunk' : 'chunks'} over about ${String(total)}ms, then the stream closes. Set repeat to 0 to keep it open forever.`}
      </p>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>Chunks</Label>
          <div className="flex items-center gap-1.5">
            <FileLoader
              onLoad={loadFile}
              onError={(message) => {
                toast.show(message);
              }}
              accept=".ndjson,.jsonl,.sse,.txt,.json,.log,.csv,text/*,application/json"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onChangeChunks([...chunks, createStreamChunk('')]);
              }}
            >
              <Plus />
              Add chunk
            </Button>
          </div>
        </div>

        {/* The list is the drop target, and so is the empty state under it:
            "drag the capture onto the chunks" only works if the chunks are
            where the file lands. */}
        {chunks.length === 0 ? (
          <p
            {...drop.handlers}
            className={cn(
              'helper rounded-xl border border-dashed border-edge px-3 py-4 text-center',
              dropRing(drop.over),
            )}
          >
            Add a chunk, or drop a file here, to give the stream something to send. One chunk per
            record: an sse event, an ndjson line, a line of text.
          </p>
        ) : (
          <ul
            {...drop.handlers}
            className={cn('flex flex-col gap-1.5 rounded-xl', dropRing(drop.over))}
          >
            {chunks.map((chunk, index) => {
              const wire = encodeStreamChunk(format, chunk.value);
              return (
                <li key={chunk.id} className="flex flex-col gap-1 rounded-xl bg-sunk/60 p-1.5">
                  <div className="flex items-start gap-1.5">
                    <span className="tabular mt-2 w-5 shrink-0 text-right font-mono text-[11px] text-ink-label">
                      {index + 1}
                    </span>

                    <Textarea
                      rows={2}
                      value={chunk.value}
                      aria-label={`Chunk ${String(index + 1)}`}
                      onChange={(event) => {
                        onChangeChunks(
                          chunks.map((item) =>
                            item.id === chunk.id ? { ...item, value: event.target.value } : item,
                          ),
                        );
                      }}
                      placeholder={format === 'text' ? 'a piece of the body' : '{"n": 1}'}
                      className="min-w-0 flex-1 bg-sunk"
                    />

                    <div className="flex shrink-0 flex-col">
                      <Tooltip label="Move up">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={index === 0}
                          aria-label={`Move chunk ${String(index + 1)} up`}
                          onClick={() => {
                            move(index, -1);
                          }}
                        >
                          <ArrowUp />
                        </Button>
                      </Tooltip>
                      <Tooltip label="Move down">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={index === chunks.length - 1}
                          aria-label={`Move chunk ${String(index + 1)} down`}
                          onClick={() => {
                            move(index, 1);
                          }}
                        >
                          <ArrowDown />
                        </Button>
                      </Tooltip>
                      <Tooltip label="Remove">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Remove chunk ${String(index + 1)}`}
                          onClick={() => {
                            onChangeChunks(chunks.filter((item) => item.id !== chunk.id));
                          }}
                        >
                          <X />
                        </Button>
                      </Tooltip>
                    </div>
                  </div>

                  {/* What the chunk becomes once the format has framed it. The
                      `data:` prefixes and the blank line that ends an event are
                      the part people get wrong, so they are shown rather than
                      described. */}
                  <p className="pl-[1.85rem] font-mono text-[11px] leading-relaxed break-all text-ink-label">
                    {wire.length === 0 ? (
                      <span className="text-warn">empty — nothing is sent for this chunk</span>
                    ) : (
                      wire.replace(/\n/g, '⏎')
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

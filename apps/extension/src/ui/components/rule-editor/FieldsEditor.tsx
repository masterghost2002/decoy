import { createId } from '@decoy/core';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/ui/components/ui/button';
import { Input, Select, Textarea } from '@/ui/components/ui/input';
import { cn } from '@/ui/lib/utils';

const FIELD_TYPES = ['string', 'number', 'boolean', 'null', 'json'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

interface FieldRow {
  id: string;
  key: string;
  type: FieldType;
  /** Always the text in the box. The type decides what it becomes in the body. */
  value: string;
}

export interface FieldsEditorProps {
  /** The json body, as the rule stores it. */
  value: string;
  onChange: (next: string) => void;
}

function describe(value: unknown): { type: FieldType; value: string } {
  if (value === null) return { type: 'null', value: '' };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'number') return { type: 'number', value: String(value) };
  if (typeof value === 'boolean') return { type: 'boolean', value: String(value) };
  return { type: 'json', value: JSON.stringify(value, null, 2) };
}

/** `null` means "this body is not a json object", which fields cannot describe. */
function rowsFromJson(text: string): FieldRow[] | null {
  if (text.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  return Object.entries(parsed).map(([key, value]) => ({
    id: createId('field'),
    key,
    ...describe(value),
  }));
}

/** A value the row cannot produce becomes `null` rather than silently vanishing. */
function valueOf(row: FieldRow): unknown {
  switch (row.type) {
    case 'string':
      return row.value;
    case 'number': {
      const parsed = Number(row.value);
      return row.value.trim().length > 0 && Number.isFinite(parsed) ? parsed : null;
    }
    case 'boolean':
      return row.value === 'true';
    case 'null':
      return null;
    case 'json':
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
  }
}

function rowError(row: FieldRow): string | null {
  if (row.type === 'number') {
    if (row.value.trim().length === 0) return 'Empty — sent as null';
    return Number.isFinite(Number(row.value)) ? null : 'Not a number — sent as null';
  }
  if (row.type === 'json') {
    if (row.value.trim().length === 0) return 'Empty — sent as null';
    try {
      JSON.parse(row.value);
      return null;
    } catch {
      return 'Not valid JSON — sent as null';
    }
  }
  return null;
}

function jsonFromRows(rows: FieldRow[]): string {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    // A row with no name is a row still being typed, not a field called "".
    if (row.key.length === 0) continue;
    out[row.key] = valueOf(row);
  }
  return JSON.stringify(out, null, 2);
}

/** Switching type keeps whatever the old text can still mean. */
function retype(row: FieldRow, type: FieldType): FieldRow {
  if (type === 'boolean') {
    return { ...row, type, value: row.value === 'true' ? 'true' : 'false' };
  }
  if (type === 'null') return { ...row, type, value: '' };
  return { ...row, type, value: row.value };
}

/**
 * The response body as named fields instead of raw json.
 *
 * Most mocked bodies are a flat object with five or six keys, and writing one by
 * hand in a textarea means owning every brace, quote and comma for the privilege
 * of changing one value. Here the shape is the form: name a field, say what kind
 * of value it holds, fill it in.
 *
 * It is a *view* over the same string the rule already stores, not a second
 * format. Nothing is migrated, the raw tab is always the truth, and a body this
 * cannot describe -- an array, a bare scalar, something invalid -- says so
 * rather than quietly flattening it.
 */
export function FieldsEditor({ value, onChange }: FieldsEditorProps) {
  const [rows, setRows] = useState<FieldRow[] | null>(() => rowsFromJson(value));
  /** The json this editor last emitted, so a parent echo does not re-derive rows. */
  const [mirror, setMirror] = useState(value);

  // Adjusted during render rather than in an effect: a rule switch must never
  // paint one rule's fields under another rule's heading.
  if (mirror !== value) {
    setMirror(value);
    setRows(rowsFromJson(value));
  }

  const commit = (next: FieldRow[]) => {
    setRows(next);
    const json = jsonFromRows(next);
    setMirror(json);
    onChange(json);
  };

  const patch = (id: string, changes: Partial<FieldRow>) => {
    commit((rows ?? []).map((row) => (row.id === id ? { ...row, ...changes } : row)));
  };

  if (rows === null) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-xl bg-sunk p-3 shadow-ring">
        <p className="helper max-w-[52ch]">
          This body is not a json object, so it has no fields to show. An array, a bare value or
          invalid json can only be edited raw.
        </p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            commit([]);
          }}
        >
          Replace it with fields
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {rows.length === 0 ? (
        <p className="helper">No fields — the body is an empty object.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => {
            const error = rowError(row);
            return (
              <li key={row.id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-start gap-1.5">
                  <Input
                    value={row.key}
                    onChange={(event) => {
                      patch(row.id, { key: event.target.value });
                    }}
                    placeholder="field"
                    aria-label="Field name"
                    autoComplete="off"
                    className="w-[9rem] min-w-0 flex-1 font-mono text-[13px]"
                  />

                  <Select
                    value={row.type}
                    aria-label="Field type"
                    className="w-[6rem] shrink-0 text-[13px]"
                    onChange={(event) => {
                      patch(row.id, retype(row, event.target.value as FieldType));
                    }}
                  >
                    {FIELD_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </Select>

                  <FieldValue
                    row={row}
                    invalid={error !== null}
                    onChange={(next) => {
                      patch(row.id, { value: next });
                    }}
                  />

                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${row.key.length > 0 ? row.key : 'this field'}`}
                    onClick={() => {
                      commit(rows.filter((item) => item.id !== row.id));
                    }}
                  >
                    <X />
                  </Button>
                </div>

                {error === null ? null : (
                  // Not blocking. The field still goes out, as null, and saying
                  // so is more use than refusing to save.
                  <p className="pl-1 text-[12px] leading-snug text-warn">{error}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            commit([...rows, { id: createId('field'), key: '', type: 'string', value: '' }]);
          }}
        >
          <Plus />
          Add field
        </Button>
      </div>
    </div>
  );
}

function FieldValue({
  row,
  invalid,
  onChange,
}: {
  row: FieldRow;
  invalid: boolean;
  onChange: (next: string) => void;
}) {
  const shared = 'min-w-0 flex-[2] basis-[10rem] font-mono text-[13px]';

  if (row.type === 'null') {
    return (
      <Input
        value="null"
        readOnly
        aria-label="Field value"
        className={cn(shared, 'text-ink-label')}
        tabIndex={-1}
      />
    );
  }

  if (row.type === 'boolean') {
    return (
      <Select
        value={row.value === 'true' ? 'true' : 'false'}
        aria-label="Field value"
        className={cn(shared, 'text-[13px]')}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    );
  }

  if (row.type === 'json') {
    return (
      <Textarea
        rows={2}
        value={row.value}
        aria-label="Field value"
        aria-invalid={invalid}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder='{"nested": true}'
        className={cn(shared, 'py-1.5')}
      />
    );
  }

  return (
    <Input
      value={row.value}
      aria-label="Field value"
      aria-invalid={invalid}
      inputMode={row.type === 'number' ? 'decimal' : undefined}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      placeholder={row.type === 'number' ? '0' : 'value'}
      autoComplete="off"
      className={shared}
    />
  );
}

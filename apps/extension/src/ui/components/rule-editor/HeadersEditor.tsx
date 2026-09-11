import type { ResponseHeader } from '@decoy/core';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/ui/components/ui/button';
import { Label } from '@/ui/components/ui/field';
import { Input } from '@/ui/components/ui/input';

export interface HeadersEditorProps {
  headers: ResponseHeader[];
  onChange: (next: ResponseHeader[]) => void;
}

export function HeadersEditor({ headers, onChange }: HeadersEditorProps) {
  const replaceAt = (index: number, patch: Partial<ResponseHeader>) => {
    onChange(headers.map((header, at) => (at === index ? { ...header, ...patch } : header)));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Response headers</Label>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange([...headers, { name: '', value: '' }]);
          }}
        >
          <Plus />
          Add
        </Button>
      </div>

      {headers.length === 0 ? (
        <p className="text-[12px] leading-snug text-ink-muted">
          Content-Type is set automatically from the body type.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {headers.map((header, index) => (
            // Index keys are correct here: rows have no stable identity and are
            // only ever edited in place or removed.
            <li key={index} className="flex items-center gap-1">
              <Input
                value={header.name}
                onChange={(event) => {
                  replaceAt(index, { name: event.target.value });
                }}
                placeholder="X-Request-Id"
                aria-label={`Header ${String(index + 1)} name`}
                className="font-mono text-[13px]"
                autoComplete="off"
              />
              <Input
                value={header.value}
                onChange={(event) => {
                  replaceAt(index, { value: event.target.value });
                }}
                placeholder="abc-123"
                aria-label={`Header ${String(index + 1)} value`}
                className="font-mono text-[13px]"
                autoComplete="off"
              />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove header ${header.name.length > 0 ? header.name : String(index + 1)}`}
                onClick={() => {
                  onChange(headers.filter((_, at) => at !== index));
                }}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

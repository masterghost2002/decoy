import { Upload } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';

import { Button } from '@/ui/components/ui/button';
import { cn } from '@/ui/lib/utils';

/**
 * Past this, a file has no business being read into a rule. Every rule lives in
 * one `chrome.storage.local` key with a quota for the whole extension, so a
 * dropped-in log file is not allowed to grow the config past the point where
 * nothing can be saved at all. The editors cap what they keep on top of this.
 */
const MAX_FILE_BYTES = 512 * 1024;

export interface LoadedFile {
  name: string;
  text: string;
}

/** Reads a picked file as text, or explains in one sentence why it did not. */
export async function readTextFile(file: File): Promise<LoadedFile> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is larger than 512KB, which is too big to keep in a rule.`);
  }
  return { name: file.name, text: await file.text() };
}

export interface FileLoaderProps {
  onLoad: (file: LoadedFile) => void;
  /** Reading a file can fail, and it must say so rather than do nothing. */
  onError: (message: string) => void;
  /** A hint for the picker only. A dropped file is read whatever it is called. */
  accept?: string;
  label?: string;
  className?: string;
}

/**
 * Loading a file has two front doors on purpose: a button for people who reach
 * for a picker, and a drop target for people who already have the file in front
 * of them. `FileLoader` is the button; `useFileDrop` is the target.
 */
export function FileLoader({
  onLoad,
  onError,
  accept,
  label = 'Load file',
  className,
}: FileLoaderProps) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        className={className}
        onClick={() => {
          input.current?.click();
        }}
      >
        <Upload />
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        {...(accept === undefined ? {} : { accept })}
        // Hidden rather than absent: the button drives it, and a styled file
        // input is not a thing browsers agree on.
        className="hidden"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared either way, or picking the same file twice fires nothing
          // the second time and the button looks broken.
          event.target.value = '';
          if (file === undefined) return;
          readTextFile(file)
            .then(onLoad)
            .catch((cause: unknown) => {
              onError(cause instanceof Error ? cause.message : String(cause));
            });
        }}
      />
    </>
  );
}

export interface FileDrop {
  /** True while a file is over the target, so it can show it will accept it. */
  over: boolean;
  handlers: {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
}

/**
 * Turns any element into a drop target for one text file.
 *
 * The `dragover` handler has to call `preventDefault` even when it does nothing
 * else: without it the browser keeps the default drop behaviour, which is to
 * navigate the surface to the dropped file and take the rule being edited with
 * it.
 */
export function useFileDrop(
  onLoad: (file: LoadedFile) => void,
  onError: (message: string) => void,
): FileDrop {
  const [over, setOver] = useState(false);

  return {
    over,
    handlers: {
      onDragOver: (event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }
      },
      onDragLeave: () => {
        setOver(false);
      },
      onDrop: (event) => {
        const file = event.dataTransfer.files[0];
        if (file === undefined) return;
        event.preventDefault();
        setOver(false);
        readTextFile(file)
          .then(onLoad)
          .catch((cause: unknown) => {
            onError(cause instanceof Error ? cause.message : String(cause));
          });
      },
    },
  };
}

/** The ring a drop target wears while a file is over it. */
export function dropRing(over: boolean): string {
  return cn(
    'transition-shadow duration-[120ms]',
    over ? 'shadow-[inset_0_0_0_2px_var(--color-gold)]' : undefined,
  );
}

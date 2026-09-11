import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Trims a url for display without hiding which endpoint it is. */
export function shortenUrl(url: string, maxLength = 64): string {
  let display = url;
  try {
    const parsed = new URL(url);
    display = `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    // Not a parseable url; show it as given.
  }
  if (display.length <= maxLength) return display;
  return `${display.slice(0, maxLength - 1)}…`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export function formatClockTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

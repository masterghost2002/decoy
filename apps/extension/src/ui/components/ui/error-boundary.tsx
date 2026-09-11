import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/ui/components/ui/button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * The last line of defence, and the reason this file exists: a component that
 * throws during render takes the whole React root down with it, and what is
 * left on screen is an empty box. In the popup that is a white rectangle; in
 * the floating panel it is a white rectangle on top of the page being
 * debugged. Either way it says nothing at all about what happened, which is
 * the worst failure mode a debugging tool can have.
 *
 * So a crash becomes a message with the error in it, and a button to try
 * again. The message is the bug report.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Also to the console, where the component stack is clickable. In the
    // panel this is the page's console, which is where someone debugging their
    // own page is already looking.
    console.error('[mocksmith] the ui crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div
        role="alert"
        className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-paper p-4 text-ink"
      >
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Mocksmith hit a bug</h2>
        <p className="max-w-[60ch] text-[13px] leading-relaxed text-ink-muted">
          The interface stopped rendering. Nothing was lost — the rules are stored in the
          extension, not on this screen, and requests are still being intercepted by the rules
          that were already saved.
        </p>
        <pre className="max-h-64 overflow-auto rounded-xl bg-sunk p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink shadow-ring">
          {error.message}
          {error.stack === undefined ? '' : `\n\n${error.stack}`}
        </pre>
        <div className="flex items-center gap-1.5">
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              // Re-mounts the tree. A crash caused by one odd traffic entry or
              // one unsaved edit usually does not come back.
              this.setState({ error: null });
            }}
          >
            Try again
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard
                .writeText(`${error.message}\n\n${error.stack ?? ''}`)
                .catch(() => undefined);
            }}
          >
            Copy the error
          </Button>
        </div>
      </div>
    );
  }
}

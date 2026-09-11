import { Button } from '@/ui/components/ui/button';

export interface FirstRunProps {
  onOpenTraffic: () => void;
  onCreateRule: () => void;
}

/**
 * An empty screen is the best teaching moment the product gets, so it is not
 * spent on a shrug and an icon. Three steps, and the primary button starts the
 * path that teaches the whole tool: see a real request, mock it, reload, watch
 * the row report that it fired.
 */
export function FirstRun({ onOpenTraffic, onCreateRule }: FirstRunProps) {
  return (
    <div className="flex h-full flex-col gap-4 px-5 pt-6 pb-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-[16.5px] font-semibold tracking-[-0.015em] text-ink">
          Decoy is on and watching.
        </h2>
        <p className="text-[13.5px] text-ink-muted">Three steps and you will see it work.</p>
      </div>

      <ol className="flex flex-col gap-3">
        {[
          'Open the page you are working on.',
          'Reload it — every fetch and XHR appears in Traffic, mocked or not.',
          'Hit ⚡ Mock this on any request to turn it into a rule.',
        ].map((step, index) => (
          <li key={step} className="flex items-start gap-2.5">
            <span
              aria-hidden
              className="grid size-[18px] shrink-0 place-items-center rounded-full border border-gold/40 bg-wash font-mono text-[10px] text-gold-text"
            >
              {index + 1}
            </span>
            <span className="text-[13.5px] leading-snug text-ink">{step}</span>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onOpenTraffic}>
          Open Traffic
        </Button>
        <Button onClick={onCreateRule}>Write a rule myself</Button>
      </div>
    </div>
  );
}

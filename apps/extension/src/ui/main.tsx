import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App, type ViewKind } from '@/ui/App';
import { ErrorBoundary } from '@/ui/components/ui/error-boundary';
import { ToastProvider } from '@/ui/components/ui/toast';
import { TooltipProvider } from '@/ui/components/ui/tooltip';

import '@/ui/styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Mocksmith UI: #root is missing from the page.');
}

// Both surfaces share one bundle and one component tree; the body attribute is
// the only thing that differs between the popup and the full tab.
const view: ViewKind = document.body.dataset.view === 'tab' ? 'tab' : 'popup';

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <TooltipProvider>
        <ToastProvider>
          <App view={view} />
        </ToastProvider>
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>,
);

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** Long enough to notice, read and act on; short enough not to sit in the way. */
const TOAST_MS = 6000;

export interface ToastAction {
  label: string;
  onAct: () => void;
}

interface Toast {
  id: number;
  message: string;
  action: ToastAction | null;
}

export interface ToastApi {
  /**
   * Confirms something that already happened. An action makes it undoable,
   * which is what lets a destructive operation skip its confirm dialog: the
   * cost moves off the common path and onto the rare mistake.
   */
  show: (message: string, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast must be used inside a ToastProvider.');
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextId = useRef(0);

  const dismiss = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setToast(null);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show: (message, action) => {
        if (timer.current !== null) clearTimeout(timer.current);
        nextId.current += 1;
        setToast({ id: nextId.current, message, action: action ?? null });
        timer.current = setTimeout(() => {
          timer.current = null;
          setToast(null);
        }, TOAST_MS);
      },
    }),
    [],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <ToastContext.Provider value={api}>
      {/* The wrapper exists for the toast below it, which is positioned against
          this box rather than against the viewport. In the floating panel the
          viewport is the whole page, and a toast confirming a rule deletion
          would appear at the bottom of the site being debugged. */}
      <div className="relative flex h-full min-h-0 flex-1 flex-col">
        {children}
        {/* Polite, and always mounted: a live region that appears at the same
            moment as its message is frequently not announced at all. */}
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute inset-x-0 bottom-3 z-50 flex justify-center px-3"
        >
          {toast === null ? null : (
            <div
              key={toast.id}
              className="pointer-events-auto flex max-w-full items-center gap-3 rounded-[10px] bg-ink px-3 py-2 text-[13.5px] font-medium text-paper shadow-pop"
            >
              <span className="min-w-0 truncate">{toast.message}</span>
              {toast.action !== null ? (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onAct();
                    dismiss();
                  }}
                  className="ml-auto shrink-0 font-semibold text-gold underline underline-offset-2"
                >
                  {toast.action.label}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

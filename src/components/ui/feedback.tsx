import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  leaving: boolean;
}

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmState {
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

export interface UIContextValue {
  toast: (message: string, type?: ToastType) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const UIContext = createContext<UIContextValue | null>(null);

const TOAST_DURATION_MS = 3500;
const TOAST_LEAVE_MS = 220;
const MAX_TOASTS = 3;

const DOT_COLOR: Record<ToastType, string> = {
  success: 'bg-green-400',
  error: 'bg-red-400',
  info: 'bg-blue-400',
};

const FEEDBACK_CSS = `
@keyframes cm-toast-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes cm-toast-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(8px); }
}
@keyframes cm-sheet-in {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
@keyframes cm-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.cm-toast-enter { animation: cm-toast-in 0.25s ease-out both; }
.cm-toast-leave { animation: cm-toast-out ${TOAST_LEAVE_MS / 1000}s ease-in both; }
.cm-sheet-enter { animation: cm-sheet-in 0.28s cubic-bezier(0.22, 1, 0.36, 1) both; }
.cm-backdrop-enter { animation: cm-fade-in 0.2s ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .cm-toast-enter, .cm-toast-leave, .cm-sheet-enter, .cm-backdrop-enter {
    animation: none !important;
  }
}
`;

export function UIProvider({ children }: { children: ReactNode }): JSX.Element {
  const [mounted, setMounted] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const idRef = useRef<number>(0);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const confirmStateRef = useRef<ConfirmState | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  confirmStateRef.current = confirmState;

  useEffect(() => {
    setMounted(true);
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timersRef.current.delete(t);
      fn();
    }, ms);
    timersRef.current.add(t);
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = 'info') => {
      idRef.current += 1;
      const id = idRef.current;
      setToasts((prev) => {
        const next = [...prev, { id, message, type, leaving: false }];
        return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
      });
      schedule(() => {
        setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
        schedule(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, TOAST_LEAVE_MS);
      }, TOAST_DURATION_MS);
    },
    [schedule]
  );

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // If a confirm is already open, cancel it before showing the new one.
      if (confirmStateRef.current) {
        confirmStateRef.current.resolve(false);
      }
      setConfirmState({ opts, resolve });
    });
  }, []);

  const closeConfirm = useCallback((result: boolean) => {
    if (confirmStateRef.current) {
      confirmStateRef.current.resolve(result);
    }
    setConfirmState(null);
  }, []);

  // Escape key + focus handling while the confirm sheet is open.
  useEffect(() => {
    if (!confirmState) return;

    lastFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelBtnRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeConfirm(false);
        return;
      }
      if (e.key === 'Tab' && sheetRef.current) {
        const focusables = sheetRef.current.querySelectorAll<HTMLElement>('button');
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (active && !sheetRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      lastFocusedRef.current?.focus();
      lastFocusedRef.current = null;
    };
  }, [confirmState, closeConfirm]);

  const value = useMemo<UIContextValue>(() => ({ toast, confirm }), [toast, confirm]);

  const overlay = mounted
    ? createPortal(
        <>
          <style>{FEEDBACK_CSS}</style>

          {/* Toast stack */}
          <div
            aria-live="polite"
            className="pointer-events-none fixed inset-x-0 z-[100] flex flex-col items-center gap-2 px-4"
            style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}
          >
            {toasts.map((t) => (
              <div
                key={t.id}
                role="status"
                className={`${
                  t.leaving ? 'cm-toast-leave' : 'cm-toast-enter'
                } pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-xl bg-slate-800 px-4 py-3 text-sm text-white shadow-lg`}
              >
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 rounded-full ${DOT_COLOR[t.type]}`}
                />
                <span className="min-w-0 break-keep">{t.message}</span>
              </div>
            ))}
          </div>

          {/* Confirm bottom sheet */}
          {confirmState && (
            <div className="fixed inset-0 z-[110] flex items-end justify-center sm:items-center">
              <button
                type="button"
                aria-label="닫기"
                tabIndex={-1}
                className="cm-backdrop-enter absolute inset-0 h-full w-full cursor-default bg-black/40"
                onClick={() => closeConfirm(false)}
              />
              <div
                ref={sheetRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="cm-confirm-title"
                className="cm-sheet-enter relative w-full max-w-md rounded-t-2xl bg-white p-5 shadow-2xl sm:mx-4 sm:rounded-2xl"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
              >
                <h2 id="cm-confirm-title" className="text-lg font-semibold text-slate-900">
                  {confirmState.opts.title}
                </h2>
                {confirmState.opts.description && (
                  <p className="mt-2 text-sm leading-relaxed text-slate-600 break-keep">
                    {confirmState.opts.description}
                  </p>
                )}
                <div className="mt-5 flex gap-2">
                  <button
                    ref={cancelBtnRef}
                    type="button"
                    className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                    onClick={() => closeConfirm(false)}
                  >
                    {confirmState.opts.cancelText ?? '취소'}
                  </button>
                  <button
                    type="button"
                    className={`flex-1 rounded-xl py-3 text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 ${
                      confirmState.opts.danger
                        ? 'bg-red-500 hover:bg-red-600 focus-visible:ring-red-400'
                        : 'bg-blue-600 hover:bg-blue-700 focus-visible:ring-blue-400'
                    }`}
                    onClick={() => closeConfirm(true)}
                  >
                    {confirmState.opts.confirmText ?? '확인'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>,
        document.body
      )
    : null;

  return (
    <UIContext.Provider value={value}>
      {children}
      {overlay}
    </UIContext.Provider>
  );
}

export function useUI(): UIContextValue {
  const ctx = useContext(UIContext);
  if (!ctx) {
    throw new Error('useUI must be used within <UIProvider>');
  }
  return ctx;
}

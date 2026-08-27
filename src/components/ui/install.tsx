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
import { useRouter } from 'next/router';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export interface InstallContextValue {
  canInstall: boolean;
  promptInstall: () => Promise<void>;
  isIOS: boolean;
  isStandalone: boolean;
  showIOSGuide: () => void;
  /** 플랫폼에 맞는 설치 안내 시트 열기 (iOS/인앱 브라우저/일반 브라우저 공통) */
  showInstallGuide: () => void;
}

const InstallContext = createContext<InstallContextValue | null>(null);

const IOS_GUIDE_STORAGE_KEY = 'classmate_ios_guide_last_shown';
const IOS_GUIDE_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000; // 14일

const INSTALL_CSS = `
@keyframes cm-install-sheet-in {
  from { transform: translateY(100%); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
.cm-install-sheet-enter { animation: cm-install-sheet-in 0.3s cubic-bezier(0.22, 1, 0.36, 1) both; }
@media (prefers-reduced-motion: reduce) {
  .cm-install-sheet-enter { animation: none !important; }
}
`;

function readLastShown(): number {
  try {
    const raw = window.localStorage.getItem(IOS_GUIDE_STORAGE_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeLastShown(ts: number): void {
  try {
    window.localStorage.setItem(IOS_GUIDE_STORAGE_KEY, String(ts));
  } catch {
    // localStorage 사용 불가(사파리 프라이빗 모드 등) 시 무시
  }
}

/** iOS 공유 아이콘 (사각형 + 위쪽 화살표) */
function ShareIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 15V4" />
      <path d="M8.5 7.5 12 4l3.5 3.5" />
      <path d="M6 11H5.5A1.5 1.5 0 0 0 4 12.5v6A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H18" />
    </svg>
  );
}

/** 브라우저 메뉴 아이콘 (점 3개) */
function MenuDotsIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="19" r="1.8" />
    </svg>
  );
}

/** 홈 화면에 추가 아이콘 (사각형 + 플러스) */
function AddToHomeIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M12 9v6" />
      <path d="M9 12h6" />
    </svg>
  );
}

export function InstallProvider({ children }: { children: ReactNode }): JSX.Element {
  const router = useRouter();
  const [mounted, setMounted] = useState<boolean>(false);
  const [canInstall, setCanInstall] = useState<boolean>(false);
  const [isIOS, setIsIOS] = useState<boolean>(false);
  const [isInApp, setIsInApp] = useState<boolean>(false);
  const [isStandalone, setIsStandalone] = useState<boolean>(false);
  const [guideOpen, setGuideOpen] = useState<boolean>(false);

  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const autoShownRef = useRef<boolean>(false);

  useEffect(() => {
    setMounted(true);

    // 플랫폼 판별 (클라이언트에서만)
    const ua = window.navigator.userAgent;
    const iosByUA = /iPhone|iPad|iPod/i.test(ua);
    // iPadOS 13+는 Mac으로 표시되므로 터치 지원 여부로 보완
    const iPadOS =
      window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1;
    setIsIOS(iosByUA || iPadOS);

    // 카카오톡·네이버·인스타그램 등 인앱 브라우저는 설치 프롬프트가 없음
    setIsInApp(/KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\//i.test(ua));

    const nav = window.navigator as Navigator & { standalone?: boolean };
    const standalone =
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches) ||
      nav.standalone === true;
    setIsStandalone(standalone);

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const onAppInstalled = () => {
      deferredPromptRef.current = null;
      setCanInstall(false);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<void> => {
    const event = deferredPromptRef.current;
    if (!event) return;
    deferredPromptRef.current = null;
    setCanInstall(false);
    try {
      await event.prompt();
      await event.userChoice;
    } catch {
      // 사용자가 프롬프트를 닫는 등 실패해도 무시
    }
  }, []);

  const showIOSGuide = useCallback((): void => {
    setGuideOpen(true);
  }, []);

  const closeGuide = useCallback((): void => {
    setGuideOpen(false);
  }, []);

  // /dashboard 방문 시 iOS 사용자에게 14일에 한 번만 자동 안내
  useEffect(() => {
    if (!mounted || !isIOS || isStandalone || autoShownRef.current) return;
    if (!router.pathname.startsWith('/dashboard')) return;

    const last = readLastShown();
    if (Date.now() - last < IOS_GUIDE_INTERVAL_MS) return;

    const t = setTimeout(() => {
      autoShownRef.current = true;
      writeLastShown(Date.now());
      setGuideOpen(true);
    }, 1200);
    return () => clearTimeout(t);
  }, [mounted, isIOS, isStandalone, router.pathname]);

  const value = useMemo<InstallContextValue>(
    () => ({
      canInstall,
      promptInstall,
      isIOS,
      isStandalone,
      showIOSGuide,
      showInstallGuide: showIOSGuide,
    }),
    [canInstall, promptInstall, isIOS, isStandalone, showIOSGuide]
  );

  const guideSheet =
    mounted && guideOpen
      ? createPortal(
          <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[90] flex justify-center px-3">
            <style>{INSTALL_CSS}</style>
            <div
              role="dialog"
              aria-labelledby="cm-ios-guide-title"
              className="cm-install-sheet-enter pointer-events-auto w-full max-w-md rounded-t-2xl bg-white p-5 shadow-2xl ring-1 ring-slate-200"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
            >
              <div className="flex items-start justify-between gap-3">
                <h2 id="cm-ios-guide-title" className="text-base font-semibold text-slate-900">
                  홈 화면에 추가하고 앱처럼 사용해 보세요
                </h2>
                <button
                  type="button"
                  aria-label="닫기"
                  className="-mr-1 -mt-1 shrink-0 rounded-full p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                  onClick={closeGuide}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>

              <ol className="mt-4 space-y-3 text-sm text-slate-600">
                {isIOS ? (
                  <>
                    <li className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                        <ShareIcon className="h-5 w-5" />
                      </span>
                      <span className="break-keep">
                        Safari 하단의 <strong className="font-semibold text-slate-800">공유 버튼</strong>을
                        눌러 주세요.
                      </span>
                    </li>
                    <li className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                        <AddToHomeIcon className="h-5 w-5" />
                      </span>
                      <span className="break-keep">
                        <strong className="font-semibold text-slate-800">&ldquo;홈 화면에 추가&rdquo;</strong>를
                        선택하면 설치가 완료돼요.
                      </span>
                    </li>
                  </>
                ) : isInApp ? (
                  <>
                    <li className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                        <MenuDotsIcon className="h-5 w-5" />
                      </span>
                      <span className="break-keep">
                        지금은 앱 안 브라우저라 설치할 수 없어요. 화면의{' '}
                        <strong className="font-semibold text-slate-800">메뉴</strong>에서{' '}
                        <strong className="font-semibold text-slate-800">&ldquo;다른 브라우저로 열기&rdquo;</strong>
                        (또는 &ldquo;Chrome으로 열기&rdquo;)를 눌러 주세요.
                      </span>
                    </li>
                    <li className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                        <AddToHomeIcon className="h-5 w-5" />
                      </span>
                      <span className="break-keep">
                        Chrome에서 메뉴(⋮) →{' '}
                        <strong className="font-semibold text-slate-800">&ldquo;홈 화면에 추가&rdquo;</strong>를
                        선택하면 설치가 완료돼요.
                      </span>
                    </li>
                  </>
                ) : (
                  <>
                    <li className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                        <MenuDotsIcon className="h-5 w-5" />
                      </span>
                      <span className="break-keep">
                        브라우저 오른쪽 위 <strong className="font-semibold text-slate-800">메뉴(⋮)</strong>를
                        눌러 주세요. (컴퓨터라면 주소창 오른쪽의 설치 아이콘)
                      </span>
                    </li>
                    <li className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                        <AddToHomeIcon className="h-5 w-5" />
                      </span>
                      <span className="break-keep">
                        <strong className="font-semibold text-slate-800">&ldquo;홈 화면에 추가&rdquo;</strong> 또는{' '}
                        <strong className="font-semibold text-slate-800">&ldquo;앱 설치&rdquo;</strong>를
                        선택하면 설치가 완료돼요.
                      </span>
                    </li>
                  </>
                )}
              </ol>

              <button
                type="button"
                className="mt-5 w-full rounded-xl bg-slate-100 py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                onClick={closeGuide}
              >
                확인했어요
              </button>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <InstallContext.Provider value={value}>
      {children}
      {guideSheet}
    </InstallContext.Provider>
  );
}

export function useInstallPrompt(): InstallContextValue {
  const ctx = useContext(InstallContext);
  if (!ctx) {
    throw new Error('useInstallPrompt must be used within <InstallProvider>');
  }
  return ctx;
}

import React, { useEffect, useState } from 'react'

type ToastType = 'success' | 'error' | 'info'
interface ToastMsg { id: number; type: ToastType; text: string }

let seq = 0
let push: ((t: ToastMsg) => void) | null = null

/** alert() 대체 — 어디서든 toast('저장되었습니다') */
export function toast(text: string, type: ToastType = 'success') {
  if (push) push({ id: ++seq, type, text })
  else if (typeof window !== 'undefined') window.alert(text) // Toaster 미장착 폴백
}

const ICONS: Record<ToastType, string> = { success: '✓', error: '!', info: 'i' }
const COLORS: Record<ToastType, string> = {
  success: 'bg-gray-900 text-white',
  error: 'bg-red-600 text-white',
  info: 'bg-blue-600 text-white',
}

export function Toaster() {
  const [items, setItems] = useState<ToastMsg[]>([])

  useEffect(() => {
    push = (t) => {
      setItems((prev) => [...prev, t])
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 3200)
    }
    return () => { push = null }
  }, [])

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
      {items.map((t) => (
        <div
          key={t.id}
          className={`animate-toast-in pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium ${COLORS[t.type]}`}
        >
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white/20 text-xs font-bold">
            {ICONS[t.type]}
          </span>
          {t.text}
        </div>
      ))}
    </div>
  )
}

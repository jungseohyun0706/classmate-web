import { useEffect, useRef, useState } from 'react'
import { attachmentRequest, type AttachmentLink } from '../lib/chatAttachmentClient'
import { attachmentContentType, formatFileSize, type ChatAttachment } from '../lib/chatAttachments'

export function AttachmentDrafts({ files, disabled, onRemove }: { files: File[]; disabled: boolean; onRemove: (index: number) => void }) {
  const [previews, setPreviews] = useState<string[]>([])
  useEffect(() => {
    const urls = files.map((file) => attachmentContentType(file.name).startsWith('image/') ? URL.createObjectURL(file) : '')
    setPreviews(urls)
    return () => urls.forEach((url) => { if (url) URL.revokeObjectURL(url) })
  }, [files])
  return <ul className="flex gap-2 overflow-x-auto px-1 pb-2" aria-label="보낼 첨부 파일">
    {files.map((file, index) => <li key={`${file.name}-${index}`} className="relative flex w-36 shrink-0 items-center gap-2 rounded-xl bg-gray-100 py-2 pl-2 pr-7">
      {previews[index] ? <img src={previews[index]} alt="" className="h-10 w-10 rounded-lg object-cover" /> : <span aria-hidden="true" className="text-2xl">📄</span>}
      <span className="min-w-0"><span className="block truncate text-xs font-semibold text-gray-800">{file.name}</span><span className="text-[11px] text-gray-500">{formatFileSize(file.size)}</span></span>
      <button type="button" aria-label={`${file.name} 첨부 취소`} disabled={disabled} onClick={() => onRemove(index)} className="absolute right-0 top-0 flex h-11 w-7 items-center justify-center text-gray-500 disabled:opacity-30">✕</button>
    </li>)}
  </ul>
}

export default function ChatAttachments({ classId, messageId, kind = 'chat', attachments, onImageLoad }: {
  classId: string; messageId: string; kind?: 'chat' | 'notice'; attachments: ChatAttachment[]; onImageLoad?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [links, setLinks] = useState<AttachmentLink[]>([])
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ url: string; name: string; download: string } | null>(null)
  const loadLinks = () => attachmentRequest<{ links: AttachmentLink[] }>({ action: 'links', classId, messageId, kind })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '200px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setError(false)
    void loadLinks().then((data) => { if (!cancelled) setLinks(data.links) }).catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
    // 첨부 내용은 발송 후 변경할 수 없습니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, classId, messageId, kind, retry])
  useEffect(() => {
    if (!lightbox) return
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [lightbox])
  const open = async (attachment: ChatAttachment, download: boolean) => {
    setBusy(attachment.path)
    try {
      const data = await loadLinks() // 오래 열어 둔 톡방에서도 만료되지 않은 주소로 엽니다.
      setLinks(data.links)
      const link = data.links.find((l) => l.path === attachment.path)
      if (!link) throw new Error('missing')
      if (!download && link.previewUrl) setLightbox({ url: link.previewUrl, name: attachment.name, download: link.downloadUrl })
      else {
        const a = document.createElement('a')
        a.href = link.downloadUrl; a.download = attachment.name; a.rel = 'noopener'; a.click()
      }
    } catch { setError(true) } finally { setBusy(null) }
  }
  return <div ref={ref} className="space-y-2">
    {attachments.map((a) => {
      const link = links.find((l) => l.path === a.path)
      return <div key={a.path} className="overflow-hidden rounded-xl border border-black/5 bg-white/70">
        {a.contentType.startsWith('image/') && (
          <button type="button" disabled={!!busy} aria-label={`${a.name} 사진 크게 보기`} onClick={() => void open(a, false)} className="block w-full min-w-36">
            {link?.previewUrl ? <img src={link.previewUrl} alt={a.name} loading="lazy" onLoad={onImageLoad} onError={() => setError(true)} className="max-h-72 w-full object-contain" /> : <span className="flex h-28 items-center justify-center text-xs text-gray-500">사진 불러오는 중…</span>}
          </button>
        )}
        <button type="button" disabled={!!busy} onClick={() => void open(a, true)} className="flex min-h-[52px] w-full items-center gap-2 px-3 py-2 text-left text-gray-800">
          <span aria-hidden="true">{a.contentType.startsWith('image/') ? '🖼️' : '📄'}</span>
          <span className="min-w-0 flex-1"><span className="block break-all text-xs font-semibold">{a.name}</span><span className="block text-[11px] text-gray-500">{formatFileSize(a.size)} · {busy === a.path ? '불러오는 중…' : '다운로드'}</span></span>
          <span aria-hidden="true" className="shrink-0">↓</span>
        </button>
      </div>
    })}
    {error && <button type="button" onClick={() => setRetry((n) => n + 1)} className="min-h-[44px] text-xs font-semibold text-blue-700">첨부를 불러오지 못했어요. 다시 시도</button>}
    {lightbox && <div role="dialog" aria-modal="true" aria-label="사진 크게 보기" className="fixed inset-0 z-[70] flex flex-col bg-black/95 p-3" onClick={() => setLightbox(null)}>
      <div className="flex items-center justify-between gap-2 text-white" style={{ paddingTop: 'env(safe-area-inset-top)' }}><span className="min-w-0 truncate text-sm">{lightbox.name}</span><button type="button" autoFocus aria-label="사진 닫기" onClick={() => setLightbox(null)} className="h-12 w-12 shrink-0 text-xl">✕</button></div>
      <img src={lightbox.url} alt={lightbox.name} className="min-h-0 w-full flex-1 object-contain" onClick={(e) => e.stopPropagation()} />
      <a href={lightbox.download} download={lightbox.name} onClick={(e) => e.stopPropagation()} className="my-3 flex min-h-[48px] items-center justify-center rounded-xl bg-white/15 text-sm font-semibold text-white">원본 다운로드</a>
    </div>}
  </div>
}

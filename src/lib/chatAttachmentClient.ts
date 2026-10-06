import { auth } from './firebase'
import { validateChatFiles } from './chatAttachments'

export interface AttachmentLink { path: string; previewUrl: string; downloadUrl: string }

export async function attachmentRequest<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('다시 로그인해 주세요.')
  const res = await fetch('/api/chat-attachments', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '첨부 파일을 처리하지 못했어요. 다시 시도해 주세요.')
  return data as T
}

function upload(file: File, policy: { url: string; fields: Record<string, string> }, progress: (n: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const cancelled = () => xhr.abort()
    const finish = (error?: Error) => {
      signal.removeEventListener('abort', cancelled)
      if (error) reject(error); else resolve()
    }
    if (signal.aborted) { reject(new DOMException('전송 취소', 'AbortError')); return }
    const data = new FormData()
    Object.entries(policy.fields).forEach(([key, value]) => data.append(key, value))
    data.append('file', file) // GCS 정책상 file 필드는 마지막이어야 합니다.
    xhr.open('POST', policy.url)
    xhr.timeout = 5 * 60 * 1000
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) progress(e.loaded / e.total) }
    xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? undefined : new Error('파일 업로드에 실패했어요. 다시 전송해 주세요.'))
    xhr.onerror = () => finish(new Error('인터넷 연결을 확인하고 다시 전송해 주세요.'))
    xhr.ontimeout = () => finish(new Error('업로드 시간이 초과됐어요. 다시 전송해 주세요.'))
    xhr.onabort = () => finish(new DOMException('전송 취소', 'AbortError'))
    signal.addEventListener('abort', cancelled, { once: true })
    xhr.send(data)
  })
}

export async function sendAttachments(options: {
  classId: string; requestId: string; files: File[]; text: string; kind: 'chat' | 'notice';
  signal: AbortSignal; onProgress: (percent: number, saving: boolean) => void;
}): Promise<{ messageId: string; kind: 'chat' | 'notice' }> {
  const error = validateChatFiles(options.files)
  if (error) throw new Error(error)
  const base = { classId: options.classId, requestId: options.requestId }
  const prepared = await attachmentRequest<{ uploads: { url: string; fields: Record<string, string> }[]; sentKind?: 'chat' | 'notice'; messageId?: string }>({ action: 'prepare', ...base, files: options.files.map(({ name, size }) => ({ name, size })) }, options.signal)
  if (prepared.sentKind && prepared.messageId) return { messageId: prepared.messageId, kind: prepared.sentKind }
  const total = options.files.reduce((sum, f) => sum + f.size, 0)
  let done = 0
  for (let i = 0; i < options.files.length; i++) {
    await upload(options.files[i], prepared.uploads[i], (fraction) => options.onProgress(Math.round((done + options.files[i].size * fraction) / total * 100), false), options.signal)
    done += options.files[i].size
  }
  options.onProgress(100, true)
  // 업로드 완료 후에는 취소를 막고, 같은 requestId로 저장 재시도 시 중복 메시지를 만들지 않습니다.
  return attachmentRequest({ action: 'send', ...base, text: options.text, kind: options.kind })
}

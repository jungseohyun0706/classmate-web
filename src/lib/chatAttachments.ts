export const MAX_CHAT_FILES = 5
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024
export const MAX_CHAT_TOTAL_BYTES = 50 * 1024 * 1024

export interface ChatAttachment {
  name: string
  size: number
  contentType: string
  path: string
}

export interface AttachmentInput { name: string; size: number }

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
}
const EXTENSIONS = new Set('jpg jpeg png gif webp avif heic heif pdf hwp hwpx doc docx ppt pptx xls xlsx csv txt zip mp4 mov mp3 m4a'.split(' '))
export const CHAT_FILE_ACCEPT = Array.from(EXTENSIONS).map((e) => `.${e}`).join(',')

export function attachmentContentType(name: string): string {
  return IMAGE_TYPES[name.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream'
}

export function validateChatFiles(files: readonly AttachmentInput[]): string | null {
  if (!files.length || files.length > MAX_CHAT_FILES) return `한 번에 파일을 ${MAX_CHAT_FILES}개까지 보낼 수 있어요.`
  let total = 0
  for (const file of files) {
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 180 || /[\x00-\x1f\x7f/\\]/.test(file.name)) return '파일 이름이 올바르지 않아요. 이름을 짧게 바꿔 주세요.'
    if (!Number.isSafeInteger(file.size) || file.size <= 0) return '빈 파일은 보낼 수 없어요.'
    if (file.size > MAX_CHAT_FILE_BYTES) return `${file.name}: 파일 하나당 20MB까지 보낼 수 있어요.`
    if (!EXTENSIONS.has(file.name.split('.').pop()?.toLowerCase() || '')) return `${file.name}: 사진, PDF, 한글·오피스 문서, ZIP 등의 파일을 선택해 주세요.`
    total += file.size
  }
  return total > MAX_CHAT_TOTAL_BYTES ? '첨부 파일의 합계는 50MB까지 보낼 수 있어요.' : null
}

export function formatFileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** 선언한 확장자만으로 HTML 등을 사진으로 표시하지 않습니다. */
export function matchesImageSignature(bytes: Uint8Array, type: string): boolean {
  const starts = (...v: number[]) => v.every((x, i) => bytes[i] === x)
  if (type === 'image/jpeg') return starts(0xff, 0xd8, 0xff)
  if (type === 'image/png') return starts(137, 80, 78, 71, 13, 10, 26, 10)
  if (type === 'image/gif') return starts(71, 73, 70, 56) && [55, 57].includes(bytes[4]) && bytes[5] === 97
  if (type === 'image/webp') return starts(82, 73, 70, 70) && [87, 69, 66, 80].every((x, i) => bytes[i + 8] === x)
  return false
}

export function canAccessChatFiles(user: Record<string, unknown>, cls: Record<string, unknown>, classId: string): boolean {
  return (user.role === 'teacher' && !!cls.schoolCode && user.schoolCode === cls.schoolCode) ||
    (user.role === 'student' && user.status === 'approved' && (user.classId === classId ||
      (Array.isArray(user.extraClassIds) && user.extraClassIds.includes(classId))))
}

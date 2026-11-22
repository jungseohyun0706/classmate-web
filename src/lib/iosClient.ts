export function isClassmateIOS(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('ClassmateIOS/')
}

export const CHAT_FILTER_MESSAGE = '다른 사람을 모욕하는 표현이 들어 있어요. 내용을 수정해 주세요.'

export function hasAbusiveLanguage(text: string): boolean {
  const clean = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '')
  return /씨[\s.]*발|씹새|좆같|애미[\s.]*뒤|(?:^|[^가-힣])(?:병신|개새끼|ㅂㅅ|ㅅㅂ)(?:$|[^가-힣])/.test(clean)
}

export interface BlockedChatAuthor { id: string; name: string }
export interface ChatReport {
  id: string
  messageId: string
  kind: 'chat' | 'notice'
  name: string
  excerpt: string
}

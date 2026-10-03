import { useSyncExternalStore } from 'react'

const noopSubscribe = () => () => {}

/**
 * 화면이 브라우저에서 React와 연결(하이드레이션)됐는지 — 서버 렌더·하이드레이션 중에는 false, 그 뒤 true.
 * 연결 전에 폼 제출 버튼을 누르면 브라우저 기본 동작(GET 제출)으로 이메일·비밀번호가 주소창 URL에 실릴 수 있어,
 * 로그인·가입 폼의 제출 버튼은 연결된 뒤에만 켭니다(폼에는 method="post"도 함께 둠).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  )
}

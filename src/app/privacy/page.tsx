export default function PrivacyPage() {
  return (
    <main className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">개인정보처리방침</h1>

      <section className="mb-4">
        <h2 className="font-semibold">회사명 및 연락처</h2>
        <p>서비스명: ClassMate</p>
        <p>운영자: (운영자 이름 또는 법인명 입력)</p>
        <p>연락처: support@classmate.kr</p>
      </section>

      <section className="mb-4">
        <h2 className="font-semibold">수집하는 개인정보 항목</h2>
        <ul className="list-disc ml-6">
          <li>필수수집 항목: 학급 식별자(학교코드, 학년, 반), 선생님/사용자 이메일(초대용, 선택), 푸시 알림용 기기 토큰(Expo/FCM 토큰)</li>
          <li>선택수집 항목: 프로필 이름(선택), 첨부파일 메타정보(파일명, URL)</li>
          <li>민감정보: 수집하지 않습니다.</li>
        </ul>
      </section>

      <section className="mb-4">
        <h2 className="font-semibold">수집 및 이용 목적</h2>
        <p>서비스 제공: 앱의 시간표·과제·공지 전달, 푸시 알림 전송</p>
        <p>공지·파일 저장: 선생님이 올린 공지 및 첨부파일 보관·열람 제공</p>
        <p>고객지원: 문의 응대 및 서비스 개선</p>
      </section>

      <section className="mb-4">
        <h2 className="font-semibold">수집 방법</h2>
        <p>사용자가 웹/앱에서 직접 입력하거나 업로드할 때 수집합니다. 푸시 알림 수신을 위해 기기에서 토큰을 발급받아 저장합니다.</p>
      </section>

      <section className="mb-4">
        <h2 className="font-semibold">보유 및 이용기간</h2>
        <p>푸시 토큰, 학급 식별자 등 서비스 제공에 필요한 정보는 서비스 종료 또는 사용자가 삭제 요청 시까지 보관합니다. 첨부파일 등 업로드 데이터는 별도 삭제 요청이 있을 때까지 보관합니다. 법령에 의해 보존할 필요가 있을 경우 해당 기간 동안 보관합니다.</p>
      </section>

      <section className="mb-4">
        <h2 className="font-semibold">제3자 제공</h2>
        <p>원칙적으로 제3자에게 제공하지 않습니다. 다만 법령에 따라 요청이 있는 경우 또는 서비스 운영을 위해 필요한 경우(예: 푸시 전송을 위한 외부 메시징 서비스) 사전 고지 후 제공할 수 있습니다.</p>
      </section>

      <section className="mb-4">
        <h2 className="font-semibold">보안조치</h2>
        <p>전송 시 HTTPS를 사용하고, 저장 시 접근 권한 최소화 및 Firebase 보안 규칙을 적용합니다. 서비스 계정/비밀키는 안전한 장소에 보관하며 공개 저장소에 업로드하지 않습니다.</p>
      </section>

      <section className="mb-4">
        <h2 className="font-semibold">이용자 권리 및 행사방법</h2>
        <p>이용자는 개인정보 열람·수정·삭제를 요청할 수 있으며, support@classmate.kr로 요청하면 지체 없이 처리합니다.</p>
      </section>

      <section className="mb-4">
        <h2 className="font-semibold">만 14세 미만 아동의 개인정보</h2>
        <p>만 14세 미만 아동의 개인정보는 보호자 동의 없이는 수집하지 않습니다. 아동 정보 수집이 필요한 경우 보호자 동의 절차를 따릅니다.</p>
      </section>

      <section className="mb-4">
        <h2 className="font-semibold">정책 변경</h2>
        <p>본 개인정보처리방침은 서비스 개선을 위해 변경될 수 있으며, 변경 시 웹사이트 공지 또는 앱 알림으로 고지합니다.</p>
      </section>

      <p className="text-sm text-gray-500">시행일: (년-월-일)</p>
    </main>
  );
}

export default function Privacy() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="text-3xl font-extrabold">개인정보처리방침</h1>
        <p className="mt-3 text-gray-600">
          ClassMate(이하 “서비스”)는 원활한 서비스 제공을 위해 아래와 같이
          개인정보를 처리합니다.
        </p>

        <section className="mt-10 space-y-3">
          <h2 className="text-xl font-bold">1. 수집 항목</h2>
          <ul className="list-disc pl-5 text-gray-700 space-y-1">
            <li>반 코드(예: 2-3A) 등 서비스 이용을 위한 입력 정보</li>
            <li>푸시 알림을 위한 기기 식별 정보(푸시 토큰)</li>
            <li>공지/과제/시간표 등 사용자가 직접 입력한 콘텐츠</li>
          </ul>
        </section>

        <section className="mt-10 space-y-3">
          <h2 className="text-xl font-bold">2. 이용 목적</h2>
          <ul className="list-disc pl-5 text-gray-700 space-y-1">
            <li>반 공지/과제/시간표 기능 제공</li>
            <li>푸시 알림 전송 및 공지 상세로 이동</li>
            <li>서비스 안정화 및 오류 대응</li>
          </ul>
        </section>

        <section className="mt-10 space-y-3">
          <h2 className="text-xl font-bold">3. 보관 및 파기</h2>
          <p className="text-gray-700">
            서비스 제공에 필요한 기간 동안 보관하며, 이용 목적이 달성되거나
            사용자가 삭제를 요청하는 경우 관련 법령 및 내부 정책에 따라
            파기합니다.
          </p>
        </section>

        <section className="mt-10 space-y-3">
          <h2 className="text-xl font-bold">4. 제3자 제공 및 처리 위탁</h2>
          <p className="text-gray-700">
            서비스는 기능 제공을 위해 Firebase 등 클라우드 서비스를 사용할 수
            있습니다.
          </p>
        </section>

        <section className="mt-10 space-y-3">
          <h2 className="text-xl font-bold">5. 문의</h2>
          <p className="text-gray-700">
            개인정보 관련 문의:{" "}
            <a className="underline font-semibold" href="mailto:jungseohyun0706@gmail.com">
              jungseohyun0706@gmail.com
            </a>
          </p>
        </section>

        <div className="mt-12">
          <a className="rounded-xl border px-5 py-3 font-semibold hover:bg-gray-50" href="/">
            ← 홈으로
          </a>
        </div>

        <p className="mt-10 text-sm text-gray-500">시행일: 2026-02-02</p>
      </div>
    </main>
  );
}
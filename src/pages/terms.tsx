import Head from 'next/head'
import Link from 'next/link'

export default function Terms() {
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10 text-gray-800 sm:py-14">
      <Head>
        <title>클래스메이트 이용약관</title>
        <meta name="description" content="클래스메이트 앱과 classmate.kr의 이용약관입니다." />
      </Head>
      <article className="mx-auto max-w-3xl rounded-xl bg-white p-6 shadow-sm sm:p-10">
        <h1 className="border-b border-gray-200 pb-5 text-3xl font-bold text-gray-900">클래스메이트 이용약관</h1>
        <div className="space-y-7 pt-6 leading-relaxed">
          <section>
            <h2 className="mb-2 text-lg font-bold text-gray-900">1. 서비스 범위</h2>
            <p>
              이 약관은 클래스메이트 앱과 classmate.kr에 적용됩니다. 클래스메이트는 교사와 학생에게 학급 시간표,
              공지, 대화, 급식과 학사일정 조회 기능을 제공하며, 교사는 수업 교환과 보결 요청 기능을 이용할 수 있습니다.
            </p>
          </section>
          <section>
            <h2 className="mb-2 text-lg font-bold text-gray-900">2. 계정과 학급 참여</h2>
            <p>
              이용자는 본인의 계정을 사용하고 로그인 정보를 안전하게 관리해야 합니다. 학교와 학급 정보는 실제
              소속에 맞게 등록해 주세요. 학급 참여와 일부 기능의 이용 범위는 교사 또는 학생 역할과 학급 승인 상태에 따라 달라집니다.
            </p>
          </section>
          <section>
            <h2 className="mb-2 text-lg font-bold text-gray-900">3. 게시물과 학급 대화</h2>
            <p>
              이용자는 본인이 공유할 권한이 있는 글, 사진, 파일만 올릴 수 있습니다. 다른 사람의 개인정보를 허락 없이
              게시하거나, 타인을 사칭하거나, 괴롭히거나, 불법 콘텐츠를 게시해서는 안 됩니다. 학급 대화의 문제는 담임
              교사 또는 아래의 운영 문의처로 알릴 수 있습니다.
            </p>
          </section>
          <section>
            <h2 className="mb-2 text-lg font-bold text-gray-900">4. 학교 정보와 알림</h2>
            <p>
              시간표, 급식, 학사일정과 보결 정보는 학교에서 제공하거나 이용자가 입력한 내용을 바탕으로 표시됩니다.
              변경된 수업과 학교의 공식 안내는 소속 학교의 공지로 확인해 주세요. 기기의 알림 설정과 네트워크 상태에 따라
              알림 도착 시간이 달라질 수 있습니다.
            </p>
            <p className="mt-2 text-sm text-gray-600">
              공공데이터 출처는 교육부·시도교육청{' '}
              <a href="https://open.neis.go.kr/" className="text-blue-700 underline">나이스 교육정보 개방 포털</a>입니다.
            </p>
          </section>
          <section>
            <h2 className="mb-2 text-lg font-bold text-gray-900">5. 개인정보와 문의</h2>
            <p>
              개인정보 처리에 관한 내용은 <Link href="/privacy" className="font-semibold text-blue-700 underline">개인정보처리방침</Link>에서
              확인할 수 있습니다. 서비스 이용과 약관에 관한 문의는{' '}
              <a href="mailto:jungseohyun7@gmail.com" className="break-all font-semibold text-blue-700 underline">jungseohyun7@gmail.com</a>으로
              보내 주세요.
            </p>
          </section>
        </div>
      </article>
    </main>
  )
}

export default function Support() {
  return (
    <main className="min-h-screen bg-white text-gray-900">
      <div className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="text-3xl font-extrabold">문의 / 지원</h1>
        <p className="mt-3 text-gray-600">
          버그 제보나 기능 요청은 아래 이메일로 보내줘.
        </p>

        <section className="mt-10 rounded-2xl border p-6">
          <h2 className="text-xl font-bold">연락처</h2>
          <p className="mt-2 text-gray-700">
            이메일:{" "}
            <a className="underline font-semibold" href="mailto:jungseohyun0706@gmail.com">
              jungseohyun0706@gmail.com
            </a>
          </p>
        </section>

        <section className="mt-6 rounded-2xl border p-6 bg-gray-50">
          <h2 className="text-xl font-bold">버그 제보 템플릿</h2>
          <pre className="mt-3 whitespace-pre-wrap text-sm text-gray-700">
{`[기기/OS]
예) iPhone 15 / iOS 17.x

[앱 버전]
예) 0.1.0

[문제]
예) 푸시 눌렀을 때 상세 이동이 안됨

[재현 방법]
1) ...
2) ...
3) ...

[스크린샷/로그]
가능하면 첨부`}
          </pre>
        </section>

        <div className="mt-12">
          <a className="rounded-xl border px-5 py-3 font-semibold hover:bg-gray-50" href="/">
            ← 홈으로
          </a>
        </div>
      </div>
    </main>
  );
}
import React from 'react';
import Head from 'next/head';

const PrivacyPolicy = () => {
  const lastUpdated = '2026년 3월 5일';
  const appName = 'Classmate';
  const developerEmail = 'jungseohyun7@gmail.com';

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <Head>
        <title>{appName} - 개인정보처리방침</title>
        <meta name="description" content={`${appName} 앱의 개인정보처리방침입니다.`} />
      </Head>
      
      <div className="max-w-3xl mx-auto bg-white shadow-sm rounded-lg p-8 sm:p-10 text-gray-800">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">{appName} 개인정보처리방침</h1>
        <p className="text-sm text-gray-500 mb-8 border-b pb-4">최종 수정일: {lastUpdated}</p>

        <section className="space-y-8 leading-relaxed">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. 수집하는 개인정보 항목</h2>
            <p>
              &apos;{appName}&apos;(이하 &apos;앱&apos;)는 서비스 제공을 위해 아래와 같은 최소한의 정보를 수집합니다.
            </p>
            <ul className="list-disc ml-5 mt-2 space-y-1">
              <li><strong>계정 정보:</strong> 소셜 로그인 시 제공되는 이메일 주소, 이름, 프로필 사진</li>
              <li><strong>학급 정보:</strong> 사용자가 직접 설정한 학교명, 학년, 반 정보</li>
              <li><strong>기기 정보:</strong> 기기 식별자, OS 버전</li>
            </ul>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. 개인정보의 수집 및 이용 목적</h2>
            <p>수집된 개인정보는 학급 시간표, 급식 정보 등 맞춤형 서비스 제공과 품질 개선을 위해서만 이용됩니다.</p>
          </div>

          <div className="bg-blue-50 p-4 rounded-md border border-blue-100 mt-10">
            <h2 className="text-lg font-semibold text-blue-900 mb-2">3. 문의처</h2>
            <p className="text-blue-800 font-medium">이메일: <a href={`mailto:${developerEmail}`} className="underline">{developerEmail}</a></p>
          </div>
        </section>
      </div>
    </div>
  );
};

export default PrivacyPolicy;

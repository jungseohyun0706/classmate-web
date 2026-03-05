// Force redeploy - version 2026.03.05.1656
import React from 'react';
import Head from 'next/head';
import Link from 'next/link';

const LandingPage = () => {
  const appName = 'Classmate';
  const tagline = '우리 반의 똑똑한 도우미';
  const description = '우르르 컴퍼니는 일상의 불편함을 기술로 해결합니다. 더 나은 교육, 더 나은 소통을 위한 플랫폼을 만듭니다.';

  return (
    <div className="min-h-screen bg-white font-sans text-gray-900">
      <Head>
        <title>Ururu Company - {appName}</title>
        <meta name="description" content={description} />
      </Head>

      {/* Navigation */}
      <nav className="max-w-7xl mx-auto px-6 py-8 flex justify-between items-center border-b border-gray-50">
        <div className="flex items-center space-x-2">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xl">U</div>
          <span className="text-2xl font-bold tracking-tight text-gray-900">ururu.kr</span>
        </div>
        <div className="flex items-center space-x-6">
          <Link href="/auth/login" className="px-5 py-2.5 bg-gray-900 text-white rounded-xl font-bold text-sm hover:bg-gray-800 transition-all shadow-lg shadow-gray-200">
            선생님 로그인
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="max-w-7xl mx-auto px-6 pt-20 pb-24 lg:pt-32">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          <div className="text-left">
            <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-bold mb-6">
              <span>Innovation for Life</span>
              <span className="w-1 h-1 bg-blue-300 rounded-full"></span>
              <span>세상을 우르르 변화시키는 혁신</span>
            </div>
            
            <h1 className="text-5xl lg:text-7xl font-extrabold tracking-tight mb-8 leading-tight">
              {tagline} <br />
              <span className="text-blue-600 font-black">{appName}</span>
            </h1>
            
            <p className="max-w-xl text-lg lg:text-xl text-gray-500 mb-12 leading-relaxed">
              {description} <br className="hidden md:block" />
              복잡한 학급 관리는 선생님용 앱으로, 즐거운 학교 생활은 학생용 앱으로 시작해보세요.
            </p>

            <div className="flex flex-col sm:flex-row space-y-4 sm:space-y-0 sm:space-x-4">
              <button className="px-8 py-4 bg-gray-900 text-white rounded-2xl font-bold text-lg hover:bg-gray-800 transition-all">
                Google Play 출시 예정
              </button>
              <button className="px-8 py-4 bg-white text-gray-900 border-2 border-gray-100 rounded-2xl font-bold text-lg hover:border-gray-200 transition-all">
                iOS 앱스토어 준비 중
              </button>
            </div>
          </div>

          <div className="hidden lg:block relative">
             <div className="absolute -inset-4 bg-blue-100 rounded-full blur-3xl opacity-30 animate-pulse"></div>
             <div className="relative bg-white p-8 rounded-[3rem] shadow-2xl border border-gray-100 transform rotate-3 hover:rotate-0 transition-transform duration-500">
                <div className="space-y-6">
                  <div className="flex items-center space-x-4 p-4 bg-blue-50 rounded-2xl">
                    <div className="text-3xl">📅</div>
                    <div>
                      <div className="font-bold text-gray-900 text-lg">스마트 시간표</div>
                      <div className="text-gray-500 text-sm italic">내일은 체육 시간이 있어요!</div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-4 p-4 bg-green-50 rounded-2xl">
                    <div className="text-3xl">🍱</div>
                    <div>
                      <div className="font-bold text-gray-900 text-lg">오늘의 급식</div>
                      <div className="text-gray-500 text-sm italic">돈까스, 샐러드, 김치...</div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-4 p-4 bg-purple-50 rounded-2xl">
                    <div className="text-3xl">📢</div>
                    <div>
                      <div className="font-bold text-gray-900 text-lg">디지털 알림장</div>
                      <div className="text-gray-500 text-sm italic">가정통신문을 확인하세요</div>
                    </div>
                  </div>
                </div>
             </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-6 py-12 border-t border-gray-100 flex flex-col md:flex-row justify-between items-center text-sm text-gray-400">
        <div className="flex items-center space-x-4">
          <span className="font-bold text-gray-900 text-lg">ururu.kr</span>
          <span>© 2026 ururu.kr. All rights reserved.</span>
        </div>
        <div className="mt-6 md:mt-0 flex space-x-8">
          <Link href="/privacy" className="hover:text-blue-600 font-medium transition-colors">개인정보처리방침</Link>
          <a href="mailto:jungseohyun7@gmail.com" className="hover:text-blue-600 font-medium transition-colors">문의하기</a>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;

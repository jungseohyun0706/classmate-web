import React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { ACCOUNT_DELETE_PATH, PRIVACY_CONTACT_EMAIL } from '../lib/accountDeletion';

const PrivacyPolicy = () => {
  const lastUpdated = '2026년 10월 30일';
  const appName = '클래스메이트(Classmate)';
  const developerEmail = PRIVACY_CONTACT_EMAIL;

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <Head>
        <title>클래스메이트 - 개인정보처리방침</title>
        <meta name="description" content={`${appName} 앱의 개인정보처리방침입니다.`} />
      </Head>

      <div className="max-w-3xl mx-auto bg-white shadow-sm rounded-lg p-8 sm:p-10 text-gray-800">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">{appName} 개인정보처리방침</h1>
        <p className="text-sm text-gray-500 mb-8 border-b pb-4">최종 수정일: {lastUpdated}</p>

        <section className="space-y-8 leading-relaxed">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. 수집하는 개인정보 항목</h2>
            <p>
              {appName}(이하 &apos;서비스&apos;)는 서비스 제공에 필요한 최소한의 정보만 처리합니다.
            </p>
            <ul className="list-disc ml-5 mt-2 space-y-1">
              <li><strong>선생님:</strong> 이름, 이메일 주소, 학교·학년·반, 직접 입력한 수업 시간표</li>
              <li><strong>학생:</strong> 이름, 이메일 주소, 학교·학년·반, 번호(선택)</li>
              <li><strong>구글 계정으로 로그인하는 경우:</strong> 구글이 제공하는 이메일 주소, 이름, 프로필 사진</li>
              <li><strong>서비스를 쓰면서 생기는 정보:</strong> 학급 톡방 메시지와 첨부한 사진·파일, 알림장과 댓글, 알림장 읽음·동의 기록, 급식 별점, 수업 교환·보결 요청 기록, 가방 체크 기록</li>
              <li><strong>자동으로 생기는 정보:</strong> 계정 고유 식별자, 푸시 알림 토큰(알림을 켠 경우), 로그인 유지와 오프라인 사용을 위해 기기(브라우저 저장소)에 저장되는 정보</li>
            </ul>
            <p className="mt-2 text-sm text-gray-600">
              급식·시간표·학사일정을 불러오려고 나이스(NEIS) 교육정보 개방 포털에 학교 코드·학년·반을 보내지만, 이름처럼 개인을 알아볼 수 있는 정보는 보내지 않습니다.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. 개인정보의 이용 목적</h2>
            <ul className="list-disc ml-5 space-y-1">
              <li>회원 가입·로그인과 본인 계정 관리</li>
              <li>학급 소속 확인과 선생님의 가입 승인</li>
              <li>시간표·급식·학사일정·알림장·학급 톡방 등 서비스 제공</li>
              <li>알림장·톡방·수업 교환 등 서비스 알림(푸시) 발송</li>
              <li>부정 이용 방지와 서비스 안정성 확보</li>
            </ul>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. 보유 기간과 파기</h2>
            <p>
              회원 정보와 서비스를 쓰면서 생긴 정보는 회원 탈퇴 시 지체 없이 삭제합니다. 내가 보낸 톡방 메시지와 첨부 파일, 내가 쓴 알림장(선생님)과 댓글, 알림장 읽음·동의 기록, 급식 별점 투표 기록도 함께 삭제합니다.
            </p>
            <p className="mt-2">다른 이용자에게 꼭 필요한 기록은 아래처럼 개인을 알아볼 수 없게 바꿔 남깁니다.</p>
            <ul className="list-disc ml-5 mt-2 space-y-1">
              <li>선생님이 맡던 반은 학생들이 계속 쓸 수 있게 담임을 &apos;담임 미정&apos;으로 바꿉니다.</li>
              <li>다른 선생님과 주고받은 수업 교환·보결 기록은 이름을 &apos;탈퇴한 선생님&apos;으로 바꾸고, 처리되지 않은 요청은 취소합니다.</li>
              <li>급식 평균 별점에는 누가 줬는지 알 수 없는 합계로만 남습니다.</li>
            </ul>
            <p className="mt-2">관계 법령에 따라 보관해야 하는 정보는 그 기간 동안만 보관합니다. 전자 파일은 복구할 수 없는 방법으로 삭제합니다.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. 회원 탈퇴와 삭제 요청</h2>
            <ul className="list-disc ml-5 space-y-1">
              <li><strong>앱에서:</strong> 선생님은 설정 › 회원 탈퇴, 학생은 &apos;오늘&apos; 화면 맨 아래 › 회원 탈퇴</li>
              <li>
                <strong>웹에서:</strong>{' '}
                <Link href={ACCOUNT_DELETE_PATH} className="text-blue-700 underline">https://classmate.kr{ACCOUNT_DELETE_PATH}</Link>
              </li>
              <li>
                <strong>메일로:</strong> 로그인할 수 없다면 <a href={`mailto:${developerEmail}`} className="text-blue-700 underline">{developerEmail}</a>로 가입한 이메일 주소와 이름, 학교·학년·반을 적어 보내 주세요. 본인인지 확인한 뒤 늦어도 10일 안에 처리합니다.
              </li>
            </ul>
            <p className="mt-2">개인정보 열람·정정·처리정지도 같은 메일로 요청할 수 있습니다.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. 제3자 제공</h2>
            <p>개인정보를 제3자에게 제공하지 않습니다. 다만 법령에 따른 요청이 있는 경우는 예외로 합니다.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">6. 처리 위탁</h2>
            <p>서비스 운영을 위해 아래 업체에 개인정보 처리를 맡기며, 이 업체들의 서버는 국외에 있을 수 있습니다.</p>
            <ul className="list-disc ml-5 mt-2 space-y-1">
              <li><strong>Google LLC</strong> (Firebase Authentication, Cloud Firestore, Cloud Storage, Firebase Cloud Messaging): 계정 인증, 데이터·첨부 파일 저장, 푸시 알림 발송</li>
              <li><strong>Vercel Inc.</strong>: 웹 서비스 호스팅</li>
            </ul>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">7. 안전성 확보 조치</h2>
            <ul className="list-disc ml-5 space-y-1">
              <li>모든 통신은 HTTPS로 암호화합니다.</li>
              <li>비밀번호는 인증 서비스에 암호화되어 저장되며 운영자도 볼 수 없습니다.</li>
              <li>본인과 같은 학급 구성원만 볼 수 있도록 접근 권한을 제한합니다.</li>
              <li>첨부 파일은 비공개로 저장하고, 볼 때마다 짧은 시간만 쓸 수 있는 링크를 발급합니다.</li>
              <li>광고나 행태 분석을 위한 쿠키·추적 도구는 쓰지 않습니다.</li>
            </ul>
          </div>

          <div className="bg-blue-50 p-4 rounded-md border border-blue-100 mt-10">
            <h2 className="text-lg font-semibold text-blue-900 mb-2">8. 문의처</h2>
            <p className="text-blue-800 font-medium">이메일: <a href={`mailto:${developerEmail}`} className="underline">{developerEmail}</a></p>
          </div>
        </section>
      </div>
    </div>
  );
};

export default PrivacyPolicy;

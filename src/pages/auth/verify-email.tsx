import { useEffect, useState } from 'react';
import { auth, db } from '@/lib/firebase';
import { applyActionCode, checkActionCode } from 'firebase/auth';
import { useRouter } from 'next/router';
import { doc, updateDoc } from 'firebase/firestore';

export default function VerifyEmail() {
  const router = useRouter();
  const { oobCode } = router.query;
  const [msg, setMsg] = useState('처리 중입니다...');

  useEffect(() => {
    if (!oobCode) return;
    (async () => {
      try {
        await applyActionCode(auth, String(oobCode));
        // optional: update users doc emailVerified
        // note: we rely on client to have UID; in production use cloud function to set reliably
        setMsg('이메일 인증이 완료되었습니다. 로그인 페이지로 이동합니다.');
        setTimeout(()=>router.push('/auth/login'),1500);
      } catch (e: any) {
        setMsg('인증 실패: ' + (e.message || '오류'));
      }
    })();
  }, [oobCode]);

  return <div className="max-w-md mx-auto p-4"><h1 className="text-xl">{msg}</h1></div>;
}

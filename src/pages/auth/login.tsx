import { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth, db } from '@/lib/firebase';
import { useRouter } from 'next/router';
import { doc, getDoc } from 'firebase/firestore';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const submit = async (e: any) => {
    e.preventDefault();
    setError(null);
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const userDoc = await getDoc(doc(db, 'users', cred.user.uid));
      const data = userDoc.data() as any;
      if (data?.schoolId) {
        // redirect to teacher dashboard placeholder
        router.push('/');
      } else {
        setError('사용자에 학교 정보가 없습니다.');
      }
    } catch (err: any) {
      setError(err.message || '로그인 실패');
    }
  };

  return (
    <div className="max-w-md mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">로그인</h1>
      <form onSubmit={submit} className="space-y-2">
        <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="이메일" className="w-full p-2 border rounded" />
        <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="비밀번호" type="password" className="w-full p-2 border rounded" />
        {error && <div className="text-red-600">{error}</div>}
        <button className="px-4 py-2 bg-blue-600 text-white rounded">로그인</button>
      </form>
    </div>
  );
}

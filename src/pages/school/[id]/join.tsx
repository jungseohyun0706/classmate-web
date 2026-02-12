import { useState } from 'react';
import { useRouter } from 'next/router';
import { auth, db } from '@/lib/firebase';
import { createUserWithEmailAndPassword, sendEmailVerification } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';

export default function JoinPage() {
  const router = useRouter();
  const { id } = router.query;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: any) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const userCred = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(userCred.user);
      // create users doc
      await setDoc(doc(db, 'users', userCred.user.uid), {
        email,
        displayName: name,
        role: 'teacher',
        schoolId: id,
        createdAt: new Date().toISOString(),
      });
      alert('가입 성공 — 이메일 인증을 확인해 주세요.');
      router.push('/auth/login');
    } catch (err: any) {
      setError(err.message || '가입 중 오류');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">교사 회원가입 — 학교: {id}</h1>
      <form onSubmit={submit} className="space-y-2">
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="이름" className="w-full p-2 border rounded" />
        <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="이메일" className="w-full p-2 border rounded" />
        <input value={password} onChange={e=>setPassword(e.target.value)} placeholder="비밀번호" type="password" className="w-full p-2 border rounded" />
        {error && <div className="text-red-600">{error}</div>}
        <button disabled={loading} className="px-4 py-2 bg-green-600 text-white rounded">가입하기</button>
      </form>
    </div>
  );
}

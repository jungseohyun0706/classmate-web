import { useState } from 'react';
import { useRouter } from 'next/router';

export default function SchoolIndex() {
  const [code, setCode] = useState('');
  const router = useRouter();

  const submit = (e: any) => {
    e.preventDefault();
    if (!code) return;
    router.push(`/school/${encodeURIComponent(code)}`);
  };

  return (
    <div className="max-w-md mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">학교 코드로 들어가기</h1>
      <form onSubmit={submit} className="space-y-2">
        <input value={code} onChange={e => setCode(e.target.value)} placeholder="학교 코드 입력" className="w-full p-2 border rounded" />
        <button className="px-4 py-2 bg-blue-600 text-white rounded">진입</button>
      </form>
    </div>
  );
}

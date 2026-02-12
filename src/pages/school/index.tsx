import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';

export default function SchoolIndex() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const router = useRouter();

  useEffect(()=>{
    const t = setTimeout(async ()=>{
      if (!q) { setResults([]); return; }
      const res = await fetch(`/api/schools?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      setResults(json.slice(0,50));
    }, 250);
    return ()=>clearTimeout(t);
  }, [q]);

  return (
    <div className="max-w-2xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">학교 선택</h1>
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="학교명 또는 코드로 검색" className="w-full p-2 border rounded mb-2" />
      <div className="border rounded p-2 max-h-80 overflow-auto">
        {results.length===0 && <div className="text-gray-500">검색어를 입력하세요(예: 서울)</div>}
        {results.map(r=> (
          <div key={r.id} className="p-2 hover:bg-gray-100 cursor-pointer" onClick={()=>router.push(`/school/${encodeURIComponent(r.id)}/join`)}>
            <div className="font-medium">{r.name}</div>
            <div className="text-sm text-gray-500">{r.id} {r.region}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

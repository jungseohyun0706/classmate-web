import React, { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { initFirebase } from '../../lib/firebase'
import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore'

initFirebase()

type School = { code: string; officeCode: string; name: string; address: string; kind: string }
type ClassRow = { classId: string; grade: number; classNm: number; teacherName?: string }

/** 학생용 진입 — 로그인 없이 학교 검색 → 반 선택 */
export default function StudentHome() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<School[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<School | null>(null)
  const [classes, setClasses] = useState<ClassRow[] | null>(null)
  const [loadingClasses, setLoadingClasses] = useState(false)
  const [recent, setRecent] = useState<{ url: string; label: string } | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem('classmate:lastClass')
      if (raw) setRecent(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [])

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!q.trim()) return
    setSearching(true)
    setSelected(null)
    setClasses(null)
    try {
      const res = await fetch(`/api/schools?q=${encodeURIComponent(q.trim())}`)
      const data = await res.json()
      setResults(data.schools || [])
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  const pickSchool = async (s: School) => {
    setSelected(s)
    setLoadingClasses(true)
    setClasses(null)
    try {
      const db = getFirestore()
      const snap = await getDocs(query(collection(db, 'classes'), where('schoolCode', '==', s.code)))
      const list: ClassRow[] = []
      snap.forEach((d) => {
        const c = d.data()
        if (c.grade && c.classNm) list.push({ classId: d.id, grade: c.grade, classNm: c.classNm, teacherName: c.teacherName })
      })
      list.sort((a, b) => a.grade - b.grade || a.classNm - b.classNm)
      setClasses(list)
    } catch (e) {
      console.error(e)
      setClasses([])
    } finally {
      setLoadingClasses(false)
    }
  }

  const classUrl = (s: School, c: ClassRow) =>
    `/s/${s.code}/${c.grade}/${c.classNm}?office=${encodeURIComponent(s.officeCode)}&name=${encodeURIComponent(s.name)}`

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-600 to-blue-500 text-white">
      <Head>
        <title>Classmate — 우리 반 시간표</title>
        <meta name="description" content="로그인 없이 우리 학교, 우리 반 시간표와 급식을 확인하세요." />
      </Head>

      <div className="max-w-lg mx-auto px-4 pt-14 pb-20">
        <div className="text-center mb-8">
          <div className="text-4xl mb-2">📅</div>
          <h1 className="text-3xl font-extrabold">우리 반 시간표</h1>
          <p className="mt-2 text-blue-100 text-sm">로그인 없이 학교만 찾으면 끝 · 시간표 변경도 바로 표시</p>
        </div>

        {recent && (
          <Link
            href={recent.url}
            className="block mb-4 bg-white/15 backdrop-blur rounded-xl px-4 py-3 text-sm font-bold hover:bg-white/25 transition"
          >
            ⚡ 바로가기 — {recent.label}
          </Link>
        )}

        <form onSubmit={search} className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="학교 이름을 검색하세요 (예: 서울중학교)"
            className="flex-1 rounded-xl px-4 py-3.5 text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-4 focus:ring-white/30 text-base"
          />
          <button
            type="submit"
            disabled={searching}
            className="bg-gray-900 px-5 rounded-xl font-bold hover:bg-gray-800 transition disabled:opacity-60"
          >
            {searching ? '…' : '검색'}
          </button>
        </form>

        {/* 학교 결과 */}
        {!selected && results.length > 0 && (
          <div className="mt-4 bg-white rounded-2xl overflow-hidden text-gray-900 divide-y divide-gray-100 shadow-xl">
            {results.slice(0, 12).map((s) => (
              <button
                key={s.code}
                onClick={() => pickSchool(s)}
                className="w-full text-left px-4 py-3 hover:bg-blue-50 transition"
              >
                <div className="font-bold">{s.name}</div>
                <div className="text-xs text-gray-500">{s.address} · {s.kind}</div>
              </button>
            ))}
          </div>
        )}

        {/* 반 선택 */}
        {selected && (
          <div className="mt-4 bg-white rounded-2xl text-gray-900 shadow-xl overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
              <div>
                <div className="font-bold">{selected.name}</div>
                <div className="text-xs text-gray-500">반을 선택하세요</div>
              </div>
              <button onClick={() => setSelected(null)} className="text-xs text-gray-400 underline">다시 검색</button>
            </div>

            {loadingClasses ? (
              <div className="p-8 text-center text-gray-400 text-sm">불러오는 중...</div>
            ) : !classes?.length ? (
              <div className="p-8 text-center text-gray-500 text-sm">
                아직 등록된 반이 없습니다.<br />
                <span className="text-xs text-gray-400">선생님이 Classmate에 시간표를 올리면 여기에 표시됩니다.</span>
              </div>
            ) : (
              <div className="p-4 grid grid-cols-3 sm:grid-cols-4 gap-2">
                {classes.map((c) => (
                  <Link
                    key={c.classId}
                    href={classUrl(selected, c)}
                    className="rounded-xl border border-gray-200 py-3 text-center font-bold text-gray-800 hover:border-blue-400 hover:bg-blue-50 transition"
                  >
                    {c.grade}-{c.classNm}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-8 text-center">
          <Link
            href="/s/demo/1/1"
            className="inline-block bg-white/10 border border-white/25 rounded-full px-4 py-2 text-xs font-bold text-blue-50 hover:bg-white/20 transition"
          >
            ✨ 우리 학교가 아직 없나요? 체험 페이지 구경하기
          </Link>
        </div>

        <p className="mt-8 text-center text-xs text-blue-200">
          선생님이신가요?{' '}
          <Link href="/auth/login" className="underline font-bold text-white">교사용 로그인</Link>
        </p>
      </div>
    </div>
  )
}

import React, { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { collection, doc, getDoc, getDocs, getFirestore, query, where } from 'firebase/firestore'
import { toast } from '../../lib/toast'
import {
  DAYS_EN, DAYS_KO, PERIODS, koToEn, classIdOf, readClassTimetable, itemsToCells,
  mondayOf, nextMondayOf, type WeekCells, type DayEn,
} from '../../lib/timetable'
import { DEMO_SCHOOL_CODE, demoClassData, demoItems, demoChanges, demoMeals } from '../../lib/demoData'

initFirebase()

interface ChangeRow {
  id: string
  day: string
  period: number
  type: 'swap' | 'substitute'
  note?: string
  classIds?: string[]
  weekOf: string
}

interface Meal {
  date: string
  type: string
  menu: string[]
  calories: string | null
}

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

/** /s/[schoolCode]/[grade]/[classNm] — 학생용 반 시간표 (로그인 불필요) */
export default function StudentClassView() {
  const router = useRouter()
  const parts = (router.query.cls as string[]) || []
  const [schoolCode, gradeS, classNmS] = parts
  const officeCode = String(router.query.office || '')
  const schoolNameQ = String(router.query.name || '')

  const [loading, setLoading] = useState(true)
  const [cells, setCells] = useState<WeekCells | null>(null)
  const [classData, setClassData] = useState<any>(null)
  const [changes, setChanges] = useState<ChangeRow[]>([])
  const [meals, setMeals] = useState<Meal[]>([])
  const [week, setWeek] = useState<'this' | 'next'>('this')
  const [resolvedOffice, setResolvedOffice] = useState(officeCode)

  const classId = schoolCode && gradeS && classNmS ? classIdOf(schoolCode, gradeS, classNmS) : null
  const weekOf = week === 'this' ? mondayOf() : nextMondayOf()

  // 오늘 요일 (주말이면 하이라이트 없음)
  const todayEn: DayEn | null = useMemo(() => {
    const dow = new Date().getDay()
    return dow >= 1 && dow <= 5 ? DAYS_EN[dow - 1] : null
  }, [])

  const isDemo = schoolCode === DEMO_SCHOOL_CODE

  /* 시간표 + 학교 정보 로드 */
  useEffect(() => {
    if (!router.isReady || !classId) return
    if (isDemo) {
      setClassData(demoClassData)
      setCells(itemsToCells(demoItems))
      setLoading(false)
      return
    }
    let alive = true
    ;(async () => {
      setLoading(true)
      try {
        const db = getFirestore()
        const { items, classData: cd } = await readClassTimetable(db, classId)
        if (!alive) return
        setClassData(cd || null)
        setCells(items.length ? itemsToCells(items) : null)

        // officeCode 확보 (쿼리 → 반 문서 → 학교 문서 순)
        let office = officeCode || cd?.officeCode || ''
        if (!office && schoolCode) {
          const sSnap = await getDoc(doc(db, 'schools', schoolCode))
          if (sSnap.exists()) office = sSnap.data().officeCode || ''
        }
        if (alive) setResolvedOffice(office)

        // 즐겨찾기 저장
        try {
          const label = `${cd?.schoolName || schoolNameQ || '우리 학교'} ${gradeS}-${classNmS}`
          localStorage.setItem(
            'classmate:lastClass',
            JSON.stringify({ url: window.location.pathname + window.location.search, label }),
          )
        } catch { /* ignore */ }
      } catch (e) {
        console.error(e)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, classId])

  /* 변경사항 로드 (주 단위) */
  useEffect(() => {
    if (!schoolCode || !classId) return
    if (isDemo) {
      setChanges(week === 'this' ? (demoChanges() as ChangeRow[]) : [])
      return
    }
    let alive = true
    ;(async () => {
      try {
        const db = getFirestore()
        const snap = await getDocs(
          query(collection(db, 'schools', schoolCode, 'changes'), where('weekOf', '==', weekOf)),
        )
        if (!alive) return
        const rows: ChangeRow[] = []
        snap.forEach((d) => {
          const c = d.data() as any
          // 이 반과 관련된 변경만 (classIds가 비어 있으면 학교 전체 공지로 간주)
          if (!Array.isArray(c.classIds) || !c.classIds.length || c.classIds.includes(classId)) {
            rows.push({ id: d.id, ...c })
          }
        })
        setChanges(rows)
      } catch (e) {
        console.error(e)
        if (alive) setChanges([])
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolCode, classId, weekOf, isDemo, week])

  /* 급식 로드 */
  useEffect(() => {
    if (isDemo) {
      setMeals(week === 'this' ? demoMeals() : [])
      return
    }
    if (!schoolCode || !resolvedOffice) return
    let alive = true
    ;(async () => {
      try {
        const mon = new Date(weekOf)
        const fri = new Date(mon)
        fri.setDate(fri.getDate() + 4)
        const res = await fetch(
          `/api/meals?officeCode=${encodeURIComponent(resolvedOffice)}&schoolCode=${encodeURIComponent(schoolCode)}&from=${ymd(mon)}&to=${ymd(fri)}`,
        )
        const data = await res.json()
        if (alive) setMeals(data.meals || [])
      } catch {
        if (alive) setMeals([])
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolCode, resolvedOffice, weekOf, isDemo, week])

  const changeAt = (day: DayEn, period: number) =>
    changes.find((c) => koToEn[c.day as keyof typeof koToEn] === day && c.period === period)

  const schoolName = classData?.schoolName || schoolNameQ || '우리 학교'
  const title = `${schoolName} ${gradeS}학년 ${classNmS}반`

  const share = async () => {
    const url = typeof window !== 'undefined' ? window.location.href : ''
    try {
      if (navigator.share) {
        await navigator.share({ title: `${title} 시간표`, url })
      } else {
        await navigator.clipboard.writeText(url)
        toast('링크가 복사되었습니다. 친구에게 공유하세요!')
      }
    } catch { /* cancelled */ }
  }

  const todayYmd = ymd(new Date())
  const lunchToday = meals.filter((m) => m.date === todayYmd && m.type.includes('중'))

  return (
    <div className="min-h-screen bg-gray-50">
      <Head>
        <title>{`${title} 시간표 — Classmate`}</title>
      </Head>

      {/* 헤더 */}
      <div className="bg-blue-600 text-white">
        <div className="max-w-3xl mx-auto px-4 py-5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <Link href="/s" className="text-blue-200 text-xs hover:text-white">← 다른 반 보기</Link>
              <h1 className="text-xl font-extrabold truncate mt-0.5">{title}</h1>
              {classData?.teacherName && (
                <p className="text-blue-100 text-xs mt-0.5">담임 {classData.teacherName} 선생님</p>
              )}
            </div>
            <button
              onClick={share}
              className="shrink-0 bg-white/15 hover:bg-white/25 rounded-lg px-3 py-2 text-sm font-bold transition"
            >
              공유 ↗
            </button>
          </div>

          <div className="mt-4 flex gap-1.5">
            {(['this', 'next'] as const).map((w) => (
              <button
                key={w}
                onClick={() => setWeek(w)}
                className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition ${
                  week === w ? 'bg-white text-blue-700' : 'bg-white/15 text-blue-100 hover:bg-white/25'
                }`}
              >
                {w === 'this' ? '이번 주' : '다음 주'}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-blue-200 self-center">{weekOf} 주</span>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        {loading ? (
          <div className="py-20 text-center text-gray-400">시간표를 불러오는 중...</div>
        ) : !cells ? (
          <div className="py-16 text-center bg-white rounded-2xl border border-dashed border-gray-300">
            <div className="text-3xl mb-2">🕐</div>
            <p className="text-gray-600 font-medium">아직 시간표가 등록되지 않았어요.</p>
            <p className="text-gray-400 text-xs mt-1">선생님이 시간표를 올리면 바로 표시됩니다.</p>
          </div>
        ) : (
          <>
            {/* 시간표 그리드 */}
            <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="py-2.5 w-12 text-xs text-gray-400 font-medium">교시</th>
                      {DAYS_KO.map((d, i) => (
                        <th
                          key={d}
                          className={`py-2.5 text-xs font-bold ${todayEn === DAYS_EN[i] && week === 'this' ? 'text-blue-600' : 'text-gray-500'}`}
                        >
                          {d}
                          {todayEn === DAYS_EN[i] && week === 'this' && (
                            <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-blue-500 align-middle" />
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {PERIODS.map((p) => (
                      <tr key={p} className="border-b border-gray-50 last:border-0">
                        <td className="py-3 text-center text-xs font-bold text-gray-400 bg-gray-50/60">{p}</td>
                        {DAYS_EN.map((day, i) => {
                          const cell = cells[day][p - 1]
                          const chg = changeAt(day, p)
                          const isToday = todayEn === day && week === 'this'
                          return (
                            <td
                              key={day}
                              className={`py-3 px-1 text-center align-middle ${chg ? 'cell-changed' : isToday ? 'bg-blue-50/60' : ''}`}
                              title={chg?.note || undefined}
                            >
                              <div className={`font-bold ${cell.subject ? 'text-gray-900' : 'text-gray-300'}`}>
                                {cell.subject || '·'}
                              </div>
                              {cell.teacher && <div className="text-[10px] text-gray-400 mt-0.5">{cell.teacher}</div>}
                              {chg && (
                                <div className="text-[10px] text-amber-700 font-bold mt-0.5">
                                  {chg.type === 'substitute' ? '보결' : '교환'}
                                </div>
                              )}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 변경사항 */}
            {changes.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <div className="font-bold text-amber-800 text-sm mb-2">📌 이번 주 시간표 변경 {changes.length}건</div>
                <ul className="space-y-1.5">
                  {changes.map((c) => (
                    <li key={c.id} className="text-xs text-amber-800 flex gap-2">
                      <span className="shrink-0 font-bold bg-amber-100 rounded px-1.5 py-0.5">
                        {c.day} {c.period}교시
                      </span>
                      <span>{c.note || (c.type === 'substitute' ? '보결 수업' : '수업 교환')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {/* 오늘의 급식 */}
        {lunchToday.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold text-gray-900">🍱 오늘의 급식</h2>
              {lunchToday[0].calories && <span className="text-[11px] text-gray-400">{lunchToday[0].calories}</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {lunchToday[0].menu.map((m) => (
                <span key={m} className="px-2.5 py-1 bg-green-50 text-green-800 rounded-full text-xs font-medium">
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 주간 급식 */}
        {meals.length > 0 && (
          <details className="bg-white rounded-2xl shadow-sm border border-gray-200 p-5">
            <summary className="font-bold text-gray-900 cursor-pointer select-none">📅 이번 주 급식 전체 보기</summary>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {meals.filter((m) => m.type.includes('중')).map((m) => (
                <div key={m.date + m.type} className={`rounded-xl border p-3 ${m.date === todayYmd ? 'border-green-300 bg-green-50/50' : 'border-gray-100'}`}>
                  <div className="text-xs font-bold text-gray-500 mb-1">
                    {m.date.slice(4, 6)}/{m.date.slice(6, 8)}
                    {m.date === todayYmd && <span className="ml-1 text-green-600">오늘</span>}
                  </div>
                  <div className="text-xs text-gray-700 leading-relaxed">{m.menu.join(', ')}</div>
                </div>
              ))}
            </div>
          </details>
        )}

        <p className="text-center text-[11px] text-gray-400 pt-2 pb-8">
          Classmate — 우리 반의 똑똑한 도우미 · <Link href="/" className="underline">소개</Link>
        </p>
      </div>
    </div>
  )
}

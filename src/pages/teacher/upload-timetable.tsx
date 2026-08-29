import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useRouter } from 'next/router'
import { auth } from '../../lib/firebase'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { useUI } from '../../components/ui/feedback'
import {
  parseTimetableSheets,
  compareClassLabels,
  DAYS,
  type CellValue,
  type ParseResult,
  type SheetInput,
} from '../../lib/timetableParser'
import { parseResultToUpload, teacherSlotToText, PERIOD_COUNT } from '../../lib/timetableConvert'

// 시간표 엑셀 업로드: 컴시간 등에서 내보낸 학급/교사/전체/주간/특별실 시간표 엑셀을
// 올리면 파싱해 미리 보여주고, 등록 시 학교 전체 반/교사 시간표를 자동 갱신합니다.

interface UploadReport {
  classesUpdated: number
  classesNotFound: string[]
  teachersMatched: string[]
  teachersSkippedExisting: string[]
  teachersAmbiguous: string[]
  teachersUnmatched: string[]
}

export default function UploadTimetablePage() {
  const router = useRouter()
  const { toast, confirm } = useUI()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)

  const [parsing, setParsing] = useState(false)
  const [fileNames, setFileNames] = useState<string[]>([])
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [selectedTeacher, setSelectedTeacher] = useState<string>('')
  const [overwriteTeachers, setOverwriteTeachers] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [report, setReport] = useState<UploadReport | null>(null)
  const [debugInfo, setDebugInfo] = useState<string[] | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  // 이미 등록된 학교 시간표 정보 (있으면 업로드 UI를 접어둠)
  const [existing, setExisting] = useState<{
    uploadedByName: string
    uploadedAt: Date | null
    classCount: number
    teacherCount: number
  } | null>(null)
  const [showUploadUi, setShowUploadUi] = useState(true)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const { db } = await import('../../lib/firebase')
        const snap = await getDoc(doc(db, 'users', u.uid))
        const data = snap.exists() ? snap.data() : null
        if (!data || data.role !== 'teacher') {
          toast('교사 계정만 사용할 수 있어요.', 'error')
          router.replace('/dashboard')
          return
        }
        if (!data.schoolCode) {
          toast('먼저 학교/반을 등록해야 해요.', 'info')
          router.replace('/teacher/register-class')
          return
        }
        setUserData(data)

        // 이미 등록된 학교 시간표가 있는지 확인 → 있으면 업로드 UI를 접어둠
        try {
          const master = await getDoc(doc(db, 'school_timetables', String(data.schoolCode)))
          if (master.exists()) {
            const m = master.data()
            setExisting({
              uploadedByName: String(m.uploadedByName || '어느 선생님'),
              uploadedAt: m.uploadedAt?.toDate?.() ?? null,
              classCount: Object.keys(m.classes || {}).length,
              teacherCount: Object.keys(m.teachers || {}).length,
            })
            setShowUploadUi(false)
          }
        } catch (e) {
          console.error('마스터 확인 실패(무시):', e)
        }
      } catch (e) {
        console.error(e)
        toast('내 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', 'error')
        router.replace('/dashboard')
        return
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, toast])

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    // 주의: FileList는 input과 연결된 라이브 객체라 input.value='' 초기화 시 비워짐
    //       — await 전에 동기적으로 스냅샷을 떠야 한다.
    const files = Array.from(fileList)
    setParsing(true)
    setReport(null)
    setParsed(null)
    setSelectedTeacher('')
    const names = files.map((f) => f.name)
    setFileNames(names)
    setDebugInfo(null)
    try {
      const XLSX = await import('xlsx')
      const sheets: SheetInput[] = []
      const debug: string[] = []
      for (const file of files) {
        const buf = await file.arrayBuffer()
        debug.push(`📄 ${file.name} — ${buf.byteLength.toLocaleString()} bytes`)
        const wb = XLSX.read(buf, { cellStyles: false })
        for (const sheetName of wb.SheetNames) {
          const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
            header: 1,
            blankrows: true,
            defval: null,
            raw: false,
          }) as CellValue[][]
          debug.push(
            `  시트 "${sheetName}": ${grid.length}행 / 1행: ${JSON.stringify(grid[0]?.slice(0, 6) ?? null)} / 2행: ${JSON.stringify(grid[1]?.slice(0, 3) ?? null)}`
          )
          sheets.push({ name: `${file.name}#${sheetName}`, grid })
        }
      }
      const result = parseTimetableSheets(sheets)
      const nClasses = Object.keys(result.classes).length
      const nTeachers = Object.keys(result.teachers).length
      if (nClasses === 0 && nTeachers === 0) {
        setDebugInfo(debug)
        toast(
          result.warnings[0] ||
            '시간표를 찾지 못했어요. 컴시간에서 내보낸 엑셀 파일이 맞는지 확인해 주세요.',
          'error'
        )
        return
      }
      setParsed(result)
      // 모바일: 미리보기 섹션이 화면 아래에 생기므로 자동 스크롤
      requestAnimationFrame(() =>
        previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      )
      toast(`반 ${nClasses}개, 교사 ${nTeachers}명의 시간표를 읽었어요.`, 'success')
    } catch (e: any) {
      console.error(e)
      setDebugInfo([`❌ 파일 읽기 오류: ${e?.message || String(e)}`])
      toast('파일을 읽지 못했어요. 엑셀(.xlsx) 파일인지 확인해 주세요.', 'error')
    } finally {
      setParsing(false)
    }
  }

  const handleUpload = async () => {
    if (!parsed || !auth.currentUser) return
    const nClasses = Object.keys(parsed.classes).length
    const nTeachers = Object.keys(parsed.teachers).length
    const ok = await confirm({
      title: '학교 시간표 등록',
      description: `반 ${nClasses}개, 교사 ${nTeachers}명의 시간표를 등록해요. 우리 학교의 반 시간표와 교사 시간표가 이 내용으로 갱신됩니다.`,
      confirmText: '등록하기',
    })
    if (!ok) return
    setUploading(true)
    try {
      const token = await auth.currentUser.getIdToken()
      const resp = await fetch('/api/timetable-upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ data: parseResultToUpload(parsed), overwriteTeachers }),
      })
      const json = await resp.json()
      if (!resp.ok) {
        toast(json.error || '등록에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
        return
      }
      setReport(json.report as UploadReport)
      toast('학교 시간표가 등록되었어요!', 'success')
    } catch (e) {
      console.error(e)
      toast('등록에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error')
    } finally {
      setUploading(false)
    }
  }

  const classLabels = useMemo(
    () => (parsed ? Object.keys(parsed.classes).sort(compareClassLabels) : []),
    [parsed]
  )
  const teacherNames = useMemo(
    () => (parsed ? Object.keys(parsed.teachers).sort((a, b) => a.localeCompare(b, 'ko')) : []),
    [parsed]
  )

  if (loading) return <div className="p-10 text-center text-black">로딩 중...</div>

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-start gap-3 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">시간표 엑셀 업로드 📥</h1>
            <p className="text-sm text-gray-600">
              {userData?.schoolName ? `${userData.schoolName} — ` : ''}
              시간표 엑셀을 올리면 우리 학교 모든 반·교사 시간표가 자동 등록돼요.
            </p>
          </div>
          <button
            onClick={() => router.push('/dashboard')}
            className="shrink-0 whitespace-nowrap min-h-[44px] text-gray-500 hover:text-gray-700 px-2 py-1"
          >
            나가기
          </button>
        </div>

        {/* 이미 등록된 학교: 상태 카드 + 업로드 UI 접기 */}
        {existing && (
          <div className="bg-white shadow rounded-xl border border-emerald-200 p-6 mb-6">
            <div className="flex items-start gap-3">
              <span className="text-2xl">✅</span>
              <div className="min-w-0">
                <h2 className="font-bold text-gray-900">
                  {userData?.schoolName} 시간표가 이미 등록되어 있어요
                </h2>
                <p className="mt-1 text-sm text-gray-600 break-keep">
                  {existing.uploadedAt
                    ? `${existing.uploadedAt.getMonth() + 1}월 ${existing.uploadedAt.getDate()}일에 `
                    : ''}
                  <b>{existing.uploadedByName}</b> 선생님이 올렸어요 — 반 {existing.classCount}개 ·
                  교사 {existing.teacherCount}명
                </p>
              </div>
            </div>
            <div className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 leading-relaxed break-keep">
              <b>선생님은 다시 올릴 필요 없어요!</b> 이미 등록된 시간표로 바로 쓸 수 있어요:
              <br />· 내 시간표: <b>내 수업 시간표 → 📥 엑셀에서 불러오기</b>
              <br />· 수업 반: <b>학생 관리</b>에 자동으로 제안돼요
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => router.push('/teacher/my-schedule')}
                className="rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white hover:bg-emerald-700 transition"
              >
                내 시간표 불러오기
              </button>
              <button
                onClick={() => router.push('/teacher/students')}
                className="rounded-xl bg-white py-3 text-sm font-bold text-emerald-700 ring-1 ring-emerald-300 hover:bg-emerald-50 transition"
              >
                학생 관리 열기
              </button>
            </div>
            {!showUploadUi && (
              <button
                onClick={() => setShowUploadUi(true)}
                className="mt-3 w-full py-2.5 text-center text-xs text-gray-400 hover:text-gray-600"
              >
                시간표가 바뀌었나요? 새 파일로 교체하기 ▾
              </button>
            )}
          </div>
        )}

        {/* 1단계: 파일 선택 */}
        {showUploadUi && (
        <div className="bg-white shadow rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="font-bold text-gray-900 mb-1">1. 엑셀 파일 선택</h2>
          <p className="text-sm text-gray-600 mb-4">
            컴시간 등에서 내보낸 <b>학급·교사·전체·주간·특별실 시간표</b> 엑셀(.xlsx)을 올려주세요.
            여러 파일을 한 번에 선택하면 서로 보완해서 더 정확해져요. (전체시간표 파일 하나만으로도 충분해요)
          </p>
          <label className="flex flex-col items-center justify-center border-2 border-dashed border-blue-300 rounded-xl py-10 cursor-pointer bg-blue-50/50 hover:bg-blue-50 transition">
            <span className="text-3xl mb-2">📄</span>
            <span className="text-sm font-bold text-blue-700">
              {parsing ? '읽는 중...' : '클릭해서 엑셀 파일 선택 (여러 개 가능)'}
            </span>
            {fileNames.length > 0 && (
              <span className="text-xs text-gray-500 mt-2">{fileNames.join(', ')}</span>
            )}
            <input
              type="file"
              accept=".xlsx,.xls"
              multiple
              className="sr-only"
              disabled={parsing}
              onChange={(e) => {
                handleFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
        </div>
        )}

        {/* 파싱 실패 시 진단 정보 */}
        {debugInfo && (
          <div className="bg-gray-900 text-gray-100 rounded-xl p-4 mb-6 text-[11px] leading-relaxed">
            <p className="font-bold mb-2 text-amber-300">
              ⚠️ 시간표를 읽지 못했어요 — 아래 진단 내용을 캡처해서 개발자에게 보내주세요
            </p>
            {debugInfo.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">{l}</div>
            ))}
          </div>
        )}

        {/* 2단계: 미리보기 */}
        {parsed && (
          <div ref={previewRef} className="bg-white shadow rounded-xl border border-gray-200 p-6 mb-6 scroll-mt-4">
            <h2 className="font-bold text-gray-900 mb-4">2. 읽은 내용 확인</h2>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <div className="bg-blue-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-extrabold text-blue-700">{classLabels.length}</div>
                <div className="text-xs text-gray-600">반</div>
              </div>
              <div className="bg-indigo-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-extrabold text-indigo-700">{teacherNames.length}</div>
                <div className="text-xs text-gray-600">교사</div>
              </div>
              <div className="bg-emerald-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-extrabold text-emerald-700">{parsed.maxPeriod}</div>
                <div className="text-xs text-gray-600">최대 교시</div>
              </div>
              <div className="bg-amber-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-extrabold text-amber-700">{parsed.sources.length}</div>
                <div className="text-xs text-gray-600">읽은 시트</div>
              </div>
            </div>

            {parsed.maxPeriod > PERIOD_COUNT && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-xs text-red-700">
                ⚠️ 이 시간표에는 {parsed.maxPeriod}교시까지 있지만 앱은 {PERIOD_COUNT}교시까지만
                지원해서, {PERIOD_COUNT + 1}교시부터는 등록에서 제외돼요.
              </div>
            )}
            {parsed.warnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-xs text-amber-800">
                {parsed.warnings.slice(0, 5).map((w, i) => (
                  <div key={i}>⚠️ {w}</div>
                ))}
              </div>
            )}

            {/* 교사 미리보기 */}
            <p className="text-xs font-bold text-gray-500 uppercase mb-2">교사 미리보기 (이름을 눌러보세요)</p>
            <div className="flex flex-wrap gap-1.5 mb-4 max-h-40 overflow-y-auto">
              {teacherNames.map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedTeacher(selectedTeacher === t ? '' : t)}
                  className={`text-sm px-3 py-1.5 rounded-full border transition ${
                    selectedTeacher === t
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-blue-50'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {selectedTeacher && parsed.teachers[selectedTeacher] && (
              <div className="overflow-x-auto mb-4 border border-gray-200 rounded-lg">
                <table className="min-w-[480px] w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-2 text-gray-500 w-12">교시</th>
                      {DAYS.map((d) => (
                        <th key={d} className="px-2 py-2 text-gray-500">{d}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {Array.from({ length: PERIOD_COUNT }, (_, p) => (
                      <tr key={p}>
                        <td className="px-2 py-2 text-center font-bold text-gray-600 bg-gray-50">{p + 1}</td>
                        {DAYS.map((_, d) => {
                          const slot = parsed.teachers[selectedTeacher][d]?.[p] || null
                          return (
                            <td key={d} className={`px-2 py-2 text-center whitespace-nowrap ${slot ? 'text-gray-900' : 'text-gray-300'}`}>
                              {slot ? teacherSlotToText(slot) : '·'}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="text-xs font-bold text-gray-500 uppercase mb-2">반 목록</p>
            <div className="flex flex-wrap gap-1.5 mb-4">
              {classLabels.map((c) => (
                <span key={c} className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-700">{c}</span>
              ))}
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-700 mb-4">
              <input
                type="checkbox"
                checked={overwriteTeachers}
                onChange={(e) => setOverwriteTeachers(e.target.checked)}
                className="rounded border-gray-300"
              />
              이미 직접 입력한 교사 시간표도 엑셀 내용으로 덮어쓰기 (체크하지 않으면 기존 입력은 보존돼요)
            </label>

            <div className="bg-blue-50 rounded-lg p-3 mb-4 text-xs text-blue-800 leading-relaxed">
              등록하면: ① 우리 학교에 만들어진 반의 <b>학급 시간표</b>가 갱신되고
              ② 이름이 일치하는 <b>가입된 선생님의 개인 시간표</b>가 자동 등록돼요.
              ③ 아직 가입 전인 선생님은 나중에 가입 후 <b>내 수업 시간표 → 엑셀에서 불러오기</b>로 한 번에 가져올 수 있어요.
            </div>

            <button
              onClick={handleUpload}
              disabled={uploading}
              className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition disabled:opacity-50"
            >
              {uploading ? '등록 중...' : '🏫 학교 시간표 등록하기'}
            </button>
          </div>
        )}

        {/* 3단계: 결과 */}
        {report && (
          <div className="bg-white shadow rounded-xl border border-gray-200 p-6">
            <h2 className="font-bold text-gray-900 mb-4">3. 등록 결과 ✅</h2>
            <ul className="text-sm text-gray-700 space-y-2">
              <li>
                🏫 학급 시간표 갱신: <b>{report.classesUpdated}개 반</b>
                {report.classesNotFound.length > 0 && (
                  <span className="text-gray-500">
                    {' '}(아직 앱에 등록 안 된 반 {report.classesNotFound.length}개는 담임 선생님이 반을 만들면 자동 반영돼요)
                  </span>
                )}
              </li>
              <li>
                👩‍🏫 개인 시간표 자동 등록: <b>{report.teachersMatched.length}명</b>
                {report.teachersMatched.length > 0 && (
                  <span className="text-gray-500"> — {report.teachersMatched.join(', ')}</span>
                )}
              </li>
              {report.teachersSkippedExisting.length > 0 && (
                <li className="text-gray-500">
                  ⏭️ 이미 입력돼 있어 건너뜀: {report.teachersSkippedExisting.join(', ')}
                </li>
              )}
              {report.teachersAmbiguous.length > 0 && (
                <li className="text-amber-700">
                  ⚠️ 동명이인이라 건너뜀 (직접 불러오기 필요): {report.teachersAmbiguous.join(', ')}
                </li>
              )}
              {report.teachersUnmatched.length > 0 && (
                <li className="text-gray-500">
                  💤 아직 미가입: {report.teachersUnmatched.length}명 — 가입 후 &lsquo;내 수업 시간표&rsquo;에서
                  본인 이름을 선택하면 바로 등록돼요.
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

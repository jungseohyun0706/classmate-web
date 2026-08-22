import React, { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { initFirebase } from '../../lib/firebase'
import { getAuth, onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc, getFirestore } from 'firebase/firestore'
import TeacherLayout from '../../components/Layout'
import { toast } from '../../lib/toast'
import {
  DAYS_KO,
  PERIODS,
  koToEn,
  classIdOf,
  writeClassTimetable,
  itemsToCells,
} from '../../lib/timetable'
import { parseTable, splitDelimited, groupRows, type ParseResult } from '../../lib/uploadParse'

initFirebase()

export default function UploadTimetable() {
  const router = useRouter()
  const auth = getAuth()

  const [loading, setLoading] = useState(true)
  const [userData, setUserData] = useState<any>(null)

  const [pasteText, setPasteText] = useState('')
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace('/auth/login')
        return
      }
      try {
        const db = getFirestore()
        const snap = await getDoc(doc(db, 'users', u.uid))
        if (snap.exists()) setUserData(snap.data())
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    })
    return () => unsub()
  }, [router, auth])

  const bundles = useMemo(() => (parsed ? groupRows(parsed.rows) : []), [parsed])
  const selectedBundle = bundles.find((b) => `${b.grade}_${b.classNm}` === selected) || bundles[0]

  /* ---------- 입력 처리 ---------- */

  const handlePaste = (text: string) => {
    setPasteText(text)
    setFileName(null)
    if (!text.trim()) {
      setParsed(null)
      return
    }
    setParsed(parseTable(splitDelimited(text)))
  }

  const handleFile = async (file: File) => {
    setFileName(file.name)
    setPasteText('')
    try {
      if (/\.(csv|tsv|txt)$/i.test(file.name)) {
        const text = await file.text()
        setParsed(parseTable(splitDelimited(text)))
        return
      }
      // xlsx
      const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'))
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await file.arrayBuffer())
      const ws = wb.worksheets.find((w) => w.name !== '안내') || wb.worksheets[0]
      if (!ws) {
        setParsed({ rows: [], errors: ['시트를 찾을 수 없습니다.'] })
        return
      }
      const table: (string | number)[][] = []
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals: (string | number)[] = []
        for (let c = 1; c <= 6; c++) {
          const cell = row.getCell(c)
          const v: any = cell?.value
          vals.push(typeof v === 'object' && v !== null ? (v.text ?? v.result ?? '') : (v ?? ''))
        }
        table.push(vals)
      })
      setParsed(parseTable(table))
    } catch (e) {
      console.error(e)
      setParsed({ rows: [], errors: ['파일을 읽지 못했습니다. 템플릿 형식(.xlsx/.csv)을 확인해 주세요.'] })
    }
  }

  /* ---------- 템플릿 다운로드 ---------- */

  const downloadTemplate = async () => {
    try {
      const ExcelJS = (await import('exceljs')).default ?? (await import('exceljs'))
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('시간표')
      ws.columns = [
        { header: '학년', key: 'g', width: 8 },
        { header: '반', key: 'c', width: 8 },
        { header: '요일', key: 'd', width: 8 },
        { header: '교시', key: 'p', width: 8 },
        { header: '과목', key: 's', width: 16 },
        { header: '선생님', key: 't', width: 14 },
      ]
      ws.getRow(1).font = { bold: true }
      ws.addRows([
        [1, 1, '월', 1, '국어', '김철수'],
        [1, 1, '월', 2, '수학', '이영희'],
        [1, 1, '화', 1, '영어', '박민준'],
        [1, 2, '월', 1, '과학', '정다은'],
      ])
      const guide = wb.addWorksheet('안내')
      guide.getCell('A1').value = 'Classmate 시간표 업로드 템플릿'
      guide.getCell('A3').value = '· 한 줄에 한 교시씩: 학년 / 반 / 요일(월~금) / 교시(1~7) / 과목 / 선생님(선택)'
      guide.getCell('A4').value = '· 전교 모든 반을 한 파일에 넣어도 됩니다. 반별로 자동 분류됩니다.'
      guide.getCell('A5').value = '· 엑셀 표를 복사해서 업로드 페이지에 붙여넣기해도 똑같이 동작합니다.'
      guide.getCell('A6').value = '· 이미 등록된 반은 새 시간표로 교체됩니다.'
      const buf = await wb.xlsx.writeBuffer()
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'classmate_시간표_템플릿.xlsx'
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      console.error(e)
      toast('템플릿 생성에 실패했습니다.', 'error')
    }
  }

  /* ---------- 적용 ---------- */

  const applyAll = async () => {
    if (!userData?.schoolCode) {
      toast('먼저 내 학교/반 등록에서 학교를 설정해 주세요.', 'error')
      router.push('/teacher/register-class')
      return
    }
    if (!bundles.length) return
    setApplying(true)
    setProgress({ done: 0, total: bundles.length })
    try {
      const db = getFirestore()
      let done = 0
      for (const b of bundles) {
        const classId = classIdOf(userData.schoolCode, b.grade, b.classNm)
        await writeClassTimetable(db, classId, b.items, {
          schoolCode: userData.schoolCode,
          schoolName: userData.schoolName || null,
          grade: b.grade,
          classNm: b.classNm,
          timetableSource: 'upload',
        })
        done += 1
        setProgress({ done, total: bundles.length })
      }
      toast(`${bundles.length}개 반의 시간표가 등록되었습니다.`)
      setParsed(null)
      setPasteText('')
      setFileName(null)
    } catch (e) {
      console.error(e)
      toast('저장 중 오류가 발생했습니다. 권한 또는 네트워크를 확인해 주세요.', 'error')
    } finally {
      setApplying(false)
      setProgress(null)
    }
  }

  if (loading) {
    return (
      <TeacherLayout title="시간표 업로드">
        <div className="p-10 text-center text-gray-500">로딩 중...</div>
      </TeacherLayout>
    )
  }

  return (
    <TeacherLayout
      title="시간표 파일 업로드 📄"
      subtitle="엑셀 파일 하나로 전교 시간표를 한 번에 등록하세요. 언제 어디서나, 업로드 즉시 학생·교사 화면에 반영됩니다."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 왼쪽: 입력 */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold text-gray-900">1. 파일 선택 또는 붙여넣기</h2>
              <button onClick={downloadTemplate} className="text-sm font-medium text-blue-600 hover:text-blue-800 underline">
                엑셀 템플릿 받기
              </button>
            </div>

            <label
              className="block border-2 border-dashed border-gray-300 rounded-xl p-6 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/50 transition"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const f = e.dataTransfer.files?.[0]
                if (f) handleFile(f)
              }}
            >
              <input
                type="file"
                accept=".xlsx,.csv,.tsv,.txt"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleFile(f)
                  e.currentTarget.value = ''
                }}
              />
              <div className="text-3xl mb-1">📂</div>
              <div className="text-sm text-gray-700 font-medium">
                {fileName ? `선택됨: ${fileName}` : '.xlsx / .csv 파일을 끌어다 놓거나 클릭해서 선택'}
              </div>
              <div className="text-xs text-gray-400 mt-1">형식: 학년 · 반 · 요일 · 교시 · 과목 · 선생님(선택)</div>
            </label>

            <div className="mt-4">
              <div className="text-xs font-bold text-gray-500 uppercase mb-1">또는 엑셀에서 복사해 붙여넣기</div>
              <textarea
                rows={6}
                value={pasteText}
                onChange={(e) => handlePaste(e.target.value)}
                placeholder={'1\t1\t월\t1\t국어\t김철수\n1\t1\t월\t2\t수학\t이영희'}
                className="w-full border border-gray-300 rounded-lg p-3 text-sm font-mono focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          {parsed && parsed.errors.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="font-bold text-amber-800 text-sm mb-2">확인이 필요한 행 {parsed.errors.length}개</div>
              <ul className="text-xs text-amber-700 space-y-1 max-h-40 overflow-y-auto">
                {parsed.errors.map((e, i) => (
                  <li key={i}>· {e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* 오른쪽: 미리보기 + 적용 */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h2 className="font-bold text-gray-900 mb-3">2. 미리보기</h2>

            {!bundles.length ? (
              <div className="text-center text-gray-400 py-12 text-sm">
                파일을 올리면 반별 시간표 미리보기가 표시됩니다.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 mb-4">
                  {bundles.map((b) => {
                    const key = `${b.grade}_${b.classNm}`
                    const active = selectedBundle && `${selectedBundle.grade}_${selectedBundle.classNm}` === key
                    return (
                      <button
                        key={key}
                        onClick={() => setSelected(key)}
                        className={`px-3 py-1.5 rounded-full text-xs font-bold transition ${
                          active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {b.grade}-{b.classNm} <span className="opacity-70">({b.items.length})</span>
                      </button>
                    )
                  })}
                </div>

                {selectedBundle && (
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="min-w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-2 py-2 w-10 text-gray-500">교시</th>
                          {DAYS_KO.map((d) => (
                            <th key={d} className="px-2 py-2 text-gray-500">{d}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {PERIODS.map((p) => {
                          const cells = itemsToCells(selectedBundle.items)
                          return (
                            <tr key={p} className="border-t border-gray-100">
                              <td className="px-2 py-2 text-center font-bold text-gray-600 bg-gray-50">{p}</td>
                              {DAYS_KO.map((d) => {
                                const cell = cells[koToEn[d]][p - 1]
                                return (
                                  <td key={d} className="px-2 py-2 text-center">
                                    <div className="font-medium text-gray-900">{cell.subject || '·'}</div>
                                    {cell.teacher && <div className="text-[10px] text-gray-400">{cell.teacher}</div>}
                                  </td>
                                )
                              })}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>

          <button
            onClick={applyAll}
            disabled={!bundles.length || applying}
            className="w-full py-4 rounded-xl bg-blue-600 text-white text-lg font-bold hover:bg-blue-700 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-200"
          >
            {applying
              ? progress
                ? `등록 중... (${progress.done}/${progress.total})`
                : '등록 중...'
              : bundles.length
                ? `${bundles.length}개 반 시간표 등록하기`
                : '시간표 등록하기'}
          </button>
          {!userData?.schoolCode && (
            <p className="text-xs text-center text-amber-600">
              ⚠ 학교 정보가 없습니다. 먼저 <Link className="underline font-bold" href="/teacher/register-class">내 학교/반 등록</Link>을 완료해 주세요.
            </p>
          )}
        </div>
      </div>
    </TeacherLayout>
  )
}

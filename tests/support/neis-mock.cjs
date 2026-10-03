// [테스트 전용] NEIS Open API 가짜 응답 — 로컬/에뮬레이터 E2E에서만 사용합니다.
// 사용: NODE_OPTIONS="--require ./tests/support/neis-mock.cjs" NEIS_MOCK_FILE=tests/fixtures/neis-mock.json next start
// open.neis.go.kr 로 가는 fetch만 가로채고, 나머지 요청은 원래 fetch로 보냅니다.
// 운영 코드에는 이 파일을 import하지 않습니다.
'use strict'
const fs = require('fs')
const path = require('path')

const FILE = process.env.NEIS_MOCK_FILE
if (!FILE) {
  module.exports = {}
  return
}
const realFetch = globalThis.fetch

function load() {
  // 테스트 중 시나리오 파일을 바꿀 수 있도록 매 요청마다 읽음
  return JSON.parse(fs.readFileSync(path.resolve(FILE), 'utf8'))
}

function rowsResponse(endpoint, rows) {
  if (!rows.length) {
    return { RESULT: { CODE: 'INFO-200', MESSAGE: '해당하는 데이터가 없습니다.' } }
  }
  return { [endpoint]: [{ head: [{ list_total_count: rows.length }, { RESULT: { CODE: 'INFO-000' } }] }, { row: rows }] }
}

function between(ymd, from, to) {
  return (!from || ymd >= from) && (!to || ymd <= to)
}

function handle(endpoint, q, db) {
  const school = q.get('SD_SCHUL_CODE') || ''
  if (db.fail && db.fail.includes(endpoint)) return { status: 500, body: { error: 'mock failure' } }
  switch (endpoint) {
    case 'schoolInfo': {
      const rows = (db.schools || []).filter((s) => !school || s.SD_SCHUL_CODE === school)
      return { body: rowsResponse(endpoint, rows) }
    }
    case 'mealServiceDietInfo': {
      const from = q.get('MLSV_FROM_YMD') || q.get('MLSV_YMD')
      const to = q.get('MLSV_TO_YMD') || q.get('MLSV_YMD')
      const rows = (db.meals || []).filter((m) => m.SD_SCHUL_CODE === school && between(m.MLSV_YMD, from, to))
      return { body: rowsResponse(endpoint, rows) }
    }
    case 'SchoolSchedule': {
      const from = q.get('AA_FROM_YMD') || q.get('AA_YMD')
      const to = q.get('AA_TO_YMD') || q.get('AA_YMD')
      const rows = (db.schedule || []).filter((r) => r.SD_SCHUL_CODE === school && between(r.AA_YMD, from, to))
      return { body: rowsResponse(endpoint, rows) }
    }
    case 'elsTimetable':
    case 'misTimetable':
    case 'hisTimetable':
    case 'spsTimetable': {
      const from = q.get('TI_FROM_YMD') || q.get('ALL_TI_YMD')
      const to = q.get('TI_TO_YMD') || q.get('ALL_TI_YMD')
      const grade = q.get('GRADE')
      const cls = q.get('CLASS_NM')
      const rows = ((db.timetables || {})[endpoint] || []).filter(
        (r) =>
          r.SD_SCHUL_CODE === school &&
          (!grade || String(r.GRADE) === grade) &&
          (!cls || String(r.CLASS_NM) === cls) &&
          between(r.ALL_TI_YMD, from, to)
      )
      return { body: rowsResponse(endpoint, rows) }
    }
    default:
      return { body: rowsResponse(endpoint, []) }
  }
}

globalThis.fetch = async function mockedFetch(input, init) {
  const url = typeof input === 'string' ? input : input && input.url
  if (typeof url === 'string' && url.startsWith('https://open.neis.go.kr/hub/')) {
    const u = new URL(url)
    const endpoint = u.pathname.replace('/hub/', '')
    const db = load()
    const { status = 200, body } = handle(endpoint, u.searchParams, db)
    if (process.env.NEIS_MOCK_LOG) console.log(`[neis-mock] ${endpoint} ${status}`)
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return realFetch(input, init)
}

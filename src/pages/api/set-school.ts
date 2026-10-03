import type { NextApiRequest, NextApiResponse } from 'next'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getAdminApp, isAdminConfigured, verifyIdToken } from '../../lib/fcm-admin'
import { fetchNeisResult } from '../../lib/neis'

// POST /api/set-school
// Header: Authorization: Bearer <Firebase ID token>
// Body: { schoolCode }
// 응답: 200 { ok:true, schoolCode, schoolName, officeCode, already? } / 400·401·403·404·409·429·503 { error }
//
// 교사의 학교 소속(users/{uid}.schoolCode)을 정하는 유일한 경로입니다.
// 보안 규칙상 클라이언트는 schoolCode를 처음 쓸 수 없고(자기 신고로 아무 학교에나 들어가는 것 차단),
// 서버가 NEIS로 학교가 실제로 있는지 확인한 뒤 한 번만 설정합니다. 학교 이름·교육청 코드도
// 클라이언트 값이 아니라 NEIS 값으로 저장합니다. 설정되면 같은 학교 기존 교사들에게
// '새 선생님 등록' 알림을 남겨, 모르는 사람이 끼어들면 알아챌 수 있게 합니다.

// NEIS 학교 코드(SD_SCHUL_CODE)는 7자리 영문 대문자·숫자 (예: 7010057, 국립대 부설 C035903, 재외 B555418)
// 형식은 쓰레기 값만 거르고, 실제 존재 여부는 아래 NEIS 조회로 확인합니다.
const SCHOOL_CODE_RE = /^[0-9A-Z]{7}$/
// 알림을 보낼 같은 학교 교사 수 상한
const NOTIFY_MAX = 200

// 시도 제한 (인스턴스별 best-effort). NEIS 조회·알림 생성이 따르므로 성공·실패 모두 셉니다.
// IP는 같은 학교 교사들이 공인 IP 하나로 함께 가입하는 경우가 많아 uid보다 넉넉하게 둡니다.
const attempts = new Map<string, { n: number; t: number }>()
const WINDOW_MS = 10 * 60 * 1000
const MAX_PER_UID = 20
const MAX_PER_IP = 60

/** 시도를 하나 세고, 한도를 넘었으면 true */
function overLimit(key: string, max: number): boolean {
  const now = Date.now()
  if (attempts.size > 5000) {
    attempts.forEach((v, k) => {
      if (now - v.t > WINDOW_MS) attempts.delete(k)
    })
  }
  const a = attempts.get(key)
  if (!a || now - a.t > WINDOW_MS) {
    attempts.set(key, { n: 1, t: now })
    return false
  }
  a.n += 1
  return a.n > max
}

const TOO_MANY = '시도가 너무 많아요. 잠시 후 다시 시도해 주세요.'
const LOCKED = '학교는 한 번 정하면 바꿀 수 없어요. 학교를 옮기셨다면 관리자에게 문의해 주세요.'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않는 요청입니다.' })
  }
  if (!isAdminConfigured()) {
    return res.status(503).json({ error: '서버 설정이 없어요. 관리자에게 문의해 주세요.' })
  }

  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  if (overLimit('ip:' + ip, MAX_PER_IP)) {
    return res.status(429).json({ error: TOO_MANY })
  }

  const authHeader = req.headers.authorization || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const decoded = await verifyIdToken(idToken)
  if (!decoded) {
    return res.status(401).json({ error: '로그인이 필요해요. 다시 로그인해 주세요.' })
  }
  if (decoded.firebase?.sign_in_provider === 'anonymous') {
    return res.status(403).json({ error: '익명 계정으로는 학교를 등록할 수 없어요.' })
  }
  if (overLimit('uid:' + decoded.uid, MAX_PER_UID)) {
    return res.status(429).json({ error: TOO_MANY })
  }

  const { schoolCode: rawCode } = (req.body ?? {}) as { schoolCode?: unknown }
  const schoolCode = typeof rawCode === 'string' ? rawCode.trim() : ''
  if (!schoolCode) {
    return res.status(400).json({ error: '학교를 선택해 주세요.' })
  }

  const app = getAdminApp()
  if (!app) return res.status(503).json({ error: '서버 초기화에 실패했어요.' })
  const db = getFirestore(app)
  const ref = db.collection('users').doc(decoded.uid)

  try {
    const meSnap = await ref.get()
    const me = meSnap.exists ? meSnap.data() || {} : {}
    if (me.role !== 'teacher') {
      return res.status(403).json({ error: '교사 계정만 학교를 등록할 수 있어요.' })
    }
    const current = me.schoolCode ? String(me.schoolCode) : ''
    if (current) {
      if (current !== schoolCode) return res.status(409).json({ error: LOCKED })
      return res.status(200).json({
        ok: true,
        already: true,
        schoolCode: current,
        schoolName: String(me.schoolName || ''),
        officeCode: String(me.officeCode || ''),
      })
    }

    if (!SCHOOL_CODE_RE.test(schoolCode)) {
      return res.status(400).json({ error: '학교 정보가 올바르지 않아요. 학교를 다시 검색해 주세요.' })
    }

    // 학교 존재 확인. NEIS 장애면 확인 없이 정하지 않음(fail-closed)
    const { ok, rows } = await fetchNeisResult('schoolInfo', { SD_SCHUL_CODE: schoolCode })
    if (!ok) {
      return res.status(503).json({ error: '학교 정보를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.' })
    }
    const row = rows.find((r) => r.SD_SCHUL_CODE === schoolCode)
    const schoolName = String(row?.SCHUL_NM ?? '').trim()
    const officeCode = String(row?.ATPT_OFCDC_SC_CODE ?? '').trim()
    if (!row || !schoolName || !officeCode) {
      return res.status(404).json({ error: '학교를 찾을 수 없어요. 학교를 다시 검색해 주세요.' })
    }

    // NEIS를 확인하는 동안 다른 요청이 먼저 정했을 수 있으니, 다시 읽어 비어 있을 때만 씀
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const d = snap.exists ? snap.data() || {} : {}
      if (d.role !== 'teacher') return { kind: 'forbidden' as const, d }
      const cur = d.schoolCode ? String(d.schoolCode) : ''
      if (cur) return { kind: cur === schoolCode ? ('already' as const) : ('conflict' as const), d }
      tx.set(ref, { schoolCode, schoolName, officeCode }, { merge: true })
      return { kind: 'set' as const, d }
    })
    if (outcome.kind === 'forbidden') {
      return res.status(403).json({ error: '교사 계정만 학교를 등록할 수 있어요.' })
    }
    if (outcome.kind === 'conflict') {
      return res.status(409).json({ error: LOCKED })
    }
    if (outcome.kind === 'already') {
      return res.status(200).json({
        ok: true,
        already: true,
        schoolCode,
        schoolName: String(outcome.d.schoolName || ''),
        officeCode: String(outcome.d.officeCode || ''),
      })
    }

    // 같은 학교 기존 교사들에게 알림 — 실패해도 학교 등록은 성공으로 응답
    try {
      const who = String(
        outcome.d.displayName || outcome.d.name || outcome.d.masterName || decoded.name || decoded.email || ''
      )
        .trim()
        .slice(0, 40)
      const teachers = await db
        .collection('users')
        .where('schoolCode', '==', schoolCode)
        .where('role', '==', 'teacher')
        .limit(NOTIFY_MAX + 1)
        .get()
      const targets = teachers.docs.filter((d) => d.id !== decoded.uid).slice(0, NOTIFY_MAX)
      if (targets.length > 0) {
        const batch = db.batch()
        for (const t of targets) {
          batch.set(t.ref.collection('notifications').doc(), {
            title: '새 선생님 등록',
            body: `${who ? `${who} 선생님이` : '새 선생님이'} 우리 학교 교사로 등록했어요. 모르는 분이면 학교 관리자에게 알려 주세요.`,
            url: '/dashboard',
            createdAt: FieldValue.serverTimestamp(),
            read: false,
          })
        }
        await batch.commit()
      }
    } catch (e) {
      console.error('set-school: notify error:', e)
    }

    return res.status(200).json({ ok: true, schoolCode, schoolName, officeCode })
  } catch (e) {
    console.error('set-school error:', e)
    return res.status(500).json({ error: '처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' })
  }
}

/**
 * 통합 시간표 데이터 모델 — 웹과 모바일 앱이 공유하는 canonical 스키마.
 *
 * canonical: classes/{classId}.timetable = TimetableItem[]
 *   TimetableItem = { id: `${dayKo}-${period}`, day: '월'..'금', period: 1..N, subject, teacher? }
 *   (기존 모바일 앱이 읽던 형식과 호환: day는 한글, id 끝에서 교시 추출 가능)
 *
 * legacy: classes/{classId}/info/timetable = { mon: string[], tue: ... } (웹 구버전)
 *   → 저장 시 양쪽 모두 기록해 하위 호환 유지, 읽기는 canonical 우선.
 */
import type { Firestore } from 'firebase/firestore';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

export const DAYS_EN = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
export const DAYS_KO = ['월', '화', '수', '목', '금'] as const;
export type DayEn = (typeof DAYS_EN)[number];
export type DayKo = (typeof DAYS_KO)[number];
export const MAX_PERIODS = 7;
export const PERIODS = [1, 2, 3, 4, 5, 6, 7] as const;

export const koToEn: Record<string, DayEn> = { 월: 'mon', 화: 'tue', 수: 'wed', 목: 'thu', 금: 'fri' };
export const enToKo: Record<DayEn, DayKo> = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금' };

export interface TimetableItem {
  id: string; // `${dayKo}-${period}` 예: '월-1'
  day: DayKo;
  period: number; // 1-base
  subject: string;
  teacher?: string;
}

/** 요일별 문자열 배열 그리드 (legacy 웹 포맷) */
export type WeekGrid = Record<DayEn, string[]>;

export interface CellInfo {
  subject: string;
  teacher?: string;
}
export type WeekCells = Record<DayEn, CellInfo[]>;

export const emptyGrid = (): WeekGrid => ({
  mon: Array(MAX_PERIODS).fill(''),
  tue: Array(MAX_PERIODS).fill(''),
  wed: Array(MAX_PERIODS).fill(''),
  thu: Array(MAX_PERIODS).fill(''),
  fri: Array(MAX_PERIODS).fill(''),
});

export const emptyCells = (): WeekCells => ({
  mon: Array.from({ length: MAX_PERIODS }, () => ({ subject: '' })),
  tue: Array.from({ length: MAX_PERIODS }, () => ({ subject: '' })),
  wed: Array.from({ length: MAX_PERIODS }, () => ({ subject: '' })),
  thu: Array.from({ length: MAX_PERIODS }, () => ({ subject: '' })),
  fri: Array.from({ length: MAX_PERIODS }, () => ({ subject: '' })),
});

export const classIdOf = (schoolCode: string, grade: number | string, classNm: number | string) =>
  `${schoolCode}_${grade}_${classNm}`;

export const parseClassId = (classId: string) => {
  const parts = classId.split('_');
  if (parts.length < 3) return null;
  const classNm = parts.pop()!;
  const grade = parts.pop()!;
  return { schoolCode: parts.join('_'), grade: Number(grade), classNm: Number(classNm) };
};

/** item 하나에서 교시 번호 파싱 (period 필드 우선, 없으면 id 끝자리) */
export const periodOf = (item: any): number => {
  if (typeof item?.period === 'number' && item.period >= 1) return item.period;
  const tail = String(item?.id || '').split('-').pop();
  const n = parseInt(tail || '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 0;
};

/** 임의 형태의 timetable 배열 → 정규화된 TimetableItem[] */
export const normalizeItems = (raw: any[]): TimetableItem[] => {
  const out: TimetableItem[] = [];
  if (!Array.isArray(raw)) return out;
  for (const it of raw) {
    const dayKo: DayKo | undefined = DAYS_KO.includes(it?.day) ? it.day : (koToEn[it?.day] ? it.day : undefined);
    const p = periodOf(it);
    const subject = String(it?.subject ?? '').trim();
    if (!dayKo || !p || p > MAX_PERIODS || !subject) continue;
    out.push({
      id: `${dayKo}-${p}`,
      day: dayKo,
      period: p,
      subject,
      ...(it?.teacher ? { teacher: String(it.teacher).trim() } : {}),
    });
  }
  return out;
};

export const itemsToCells = (items: TimetableItem[]): WeekCells => {
  const cells = emptyCells();
  for (const it of normalizeItems(items)) {
    const en = koToEn[it.day];
    if (!en) continue;
    cells[en][it.period - 1] = { subject: it.subject, ...(it.teacher ? { teacher: it.teacher } : {}) };
  }
  return cells;
};

export const gridToItems = (grid: Partial<WeekGrid>, teacherGrid?: Partial<WeekGrid>): TimetableItem[] => {
  const items: TimetableItem[] = [];
  for (const en of DAYS_EN) {
    const col = grid?.[en];
    if (!Array.isArray(col)) continue;
    col.forEach((subject, idx) => {
      const s = String(subject ?? '').trim();
      if (!s) return;
      const teacher = String(teacherGrid?.[en]?.[idx] ?? '').trim();
      items.push({
        id: `${enToKo[en]}-${idx + 1}`,
        day: enToKo[en],
        period: idx + 1,
        subject: s,
        ...(teacher ? { teacher } : {}),
      });
    });
  }
  return items;
};

export const cellsToSubjectGrid = (cells: WeekCells): WeekGrid => {
  const g = emptyGrid();
  for (const en of DAYS_EN) g[en] = cells[en].map((c) => c.subject || '');
  return g;
};

/**
 * 반 시간표 읽기 — canonical(classes.timetable) 우선, 없으면 legacy(info/timetable) 폴백.
 */
export async function readClassTimetable(
  db: Firestore,
  classId: string,
): Promise<{ items: TimetableItem[]; source: 'canonical' | 'legacy' | 'none'; classData?: any }> {
  const classSnap = await getDoc(doc(db, 'classes', classId));
  const classData = classSnap.exists() ? classSnap.data() : undefined;

  if (classData && Array.isArray(classData.timetable) && classData.timetable.length) {
    return { items: normalizeItems(classData.timetable), source: 'canonical', classData };
  }

  const legacySnap = await getDoc(doc(db, 'classes', classId, 'info', 'timetable'));
  if (legacySnap.exists()) {
    const g = legacySnap.data() as Partial<WeekGrid>;
    const items = gridToItems(g);
    if (items.length) return { items, source: 'legacy', classData };
  }
  return { items: [], source: 'none', classData };
}

/**
 * 반 시간표 저장 — canonical과 legacy 양쪽에 기록 (구버전 웹/앱 호환).
 * extra: 반 문서에 함께 merge할 필드 (schoolCode, schoolName, grade, classNm, teacherId 등)
 */
export async function writeClassTimetable(
  db: Firestore,
  classId: string,
  items: TimetableItem[],
  extra: Record<string, any> = {},
) {
  const normalized = normalizeItems(items);
  await setDoc(
    doc(db, 'classes', classId),
    {
      classId,
      ...extra,
      timetable: normalized,
      timetableUpdatedAt: serverTimestamp(),
    },
    { merge: true },
  );
  const cells = itemsToCells(normalized);
  await setDoc(doc(db, 'classes', classId, 'info', 'timetable'), cellsToSubjectGrid(cells), { merge: false });
}

/** 전교 반 시간표에서 특정 교사의 개인 시간표 도출 */
export function deriveTeacherSchedule(
  classes: { classId: string; label: string; items: TimetableItem[] }[],
  teacherName: string,
): Record<DayEn, ({ subject: string; classLabel: string } | null)[]> {
  const name = teacherName.trim();
  const grid: Record<DayEn, ({ subject: string; classLabel: string } | null)[]> = {
    mon: Array(MAX_PERIODS).fill(null),
    tue: Array(MAX_PERIODS).fill(null),
    wed: Array(MAX_PERIODS).fill(null),
    thu: Array(MAX_PERIODS).fill(null),
    fri: Array(MAX_PERIODS).fill(null),
  };
  if (!name) return grid;
  for (const cls of classes) {
    for (const it of cls.items) {
      if (!it.teacher || it.teacher.trim() !== name) continue;
      const en = koToEn[it.day];
      if (!en) continue;
      grid[en][it.period - 1] = { subject: it.subject, classLabel: cls.label };
    }
  }
  return grid;
}

/* ===== 변경사항(교환/보강) — 컴시간알리미의 '노란 칸' ===== */
export interface TimetableChange {
  id?: string;
  schoolCode: string;
  day: DayKo;
  period: number;
  type: 'swap' | 'substitute';
  /** 영향을 받는 반 (담임 반 등) — 학생 화면 하이라이트에 사용 */
  classIds: string[];
  aName: string;
  bName?: string;
  aSubject?: string;
  bSubject?: string;
  note?: string;
  /** ISO 주 시작(월요일) 날짜 'YYYY-MM-DD' — 해당 주에만 표시 */
  weekOf: string;
  createdAt?: any;
}

/** 이번 주 월요일 날짜 (로컬 기준) */
export const mondayOf = (d = new Date()): string => {
  const date = new Date(d);
  const dow = (date.getDay() + 6) % 7; // 월=0
  date.setDate(date.getDate() - dow);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

export const nextMondayOf = (d = new Date()): string => {
  const date = new Date(d);
  date.setDate(date.getDate() + 7);
  return mondayOf(date);
};

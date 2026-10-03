// 시간표 엑셀(컴시간 내보내기) 파서.
// SheetJS 등 외부 의존성 없이 "셀 그리드(배열의 배열)"만 입력으로 받는다.
// 지원 형식 (모두 자동 감지, 여러 파일을 섞어 넣어도 병합됨):
//  - 학급시간표: 반별 블록, 셀 = "과목\n교사(\n특별실)"
//  - 교사시간표: 교사별 블록, 셀 = "반코드\n과목" (301 → 3-1)
//  - 특별실시간표: 특별실별 블록, 셀 = "반코드 과목\n교사"
//  - 전체시간표: 행=반, 열=요일×교시 평면화, 셀 = "과목\n교사(\n특별실)"
//  - 주간시간표: 행=교사("이름(총시수)"), 열=요일×교시 평면화, 셀 = "반코드\n과목"
//
// 새 개인 시간표(수업·차시)로 가져올 때는 맨 아래 extractImportRows를 쓴다 — 칸마다 출처(시트·행·열)를
// 남기고, 역산·보충 없이 파일에 실제로 있던 칸만 돌려준다. parseTimetableSheets의 동작은 그대로다.

import type { Weekday } from './timetable/types';
import {
  normalizeClassLabel,
  normalizeTeacherName,
  normSpace,
  parseTimeText,
  type ImportRow,
} from './timetable/importRows';

export type CellValue = string | number | null | undefined;

export interface SheetInput {
  /** 시트 이름 (감지 보조용, 없어도 됨) */
  name: string;
  /** sheet_to_json(ws, { header: 1 }) 형태의 2차원 배열 */
  grid: CellValue[][];
}

export interface Lesson {
  subject: string;
  teacher?: string;
  room?: string;
}

export interface TeacherSlot {
  classLabel: string; // "1-1" 같은 반 표기 또는 원본 라벨
  subject: string;
  room?: string;
}

/** grid[요일 0=월..4=금][교시-1] */
export type ClassGrid = (Lesson | null)[][];
export type TeacherGrid = (TeacherSlot | null)[][];

export interface ParseResult {
  /** 반 라벨("1-1") → 주간 그리드 */
  classes: Record<string, ClassGrid>;
  /** 교사 이름 → 주간 그리드 */
  teachers: Record<string, TeacherGrid>;
  /** 교시별 시작시각 ("09:10" 등, 발견된 경우) */
  periodTimes: Record<number, string>;
  /** 최대 교시 수 (요일별로 다를 수 있어 최대값) */
  maxPeriod: number;
  /** 파싱된 시트 유형 요약 */
  sources: string[];
  warnings: string[];
}

export const DAYS = ['월', '화', '수', '목', '금'] as const;

const DAY_SET = new Set<string>(DAYS as readonly string[]);

// ---------- 공용 유틸 ----------

const asText = (v: CellValue): string =>
  v === null || v === undefined ? '' : String(v).replace(/\r/g, '').trim();

const cellLines = (v: CellValue): string[] =>
  asText(v)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** "조혜선(15)" → "조혜선" */
const stripHourCount = (name: string): string => name.replace(/\s*\(\d+\)\s*$/, '').trim();

/** "301" → "3-1", "111" → "1-11". 형식이 다르면 원본 반환 */
export const classCodeToLabel = (code: string): string => {
  const m = code.match(/^(\d)(\d{2})$/);
  if (m) return `${m[1]}-${parseInt(m[2], 10)}`;
  const m2 = code.match(/^(\d+)-(\d+)$/);
  if (m2) return `${parseInt(m2[1], 10)}-${parseInt(m2[2], 10)}`;
  return code;
};

/** "1교시\n(09:10)" / "1교시(09:10)" → { period: 1, time: "09:10" } */
const parsePeriodCell = (v: CellValue): { period: number; time?: string } | null => {
  const t = asText(v);
  const m = t.match(/^(\d+)\s*교시/);
  if (!m) return null;
  const time = t.match(/\((\d{1,2}:\d{2})\)/);
  return { period: parseInt(m[1], 10), time: time ? time[1] : undefined };
};

/** 사람 이름으로 볼 만한 문자열(한글 2~5자 또는 라틴 문자 이름 — 원어민 교사 등) */
const looksLikeTeacherName = (s: string): boolean =>
  /^[가-힣]{2,5}$/.test(s) || /^[A-Za-z][A-Za-z .'-]{1,19}$/.test(s);

const isEmptyLesson = (lines: string[]): boolean => lines.length === 0;

// ---------- 셀 해석 ----------

/** 학급/전체시간표 셀: [과목, 교사?, 특별실?] */
const parseClassCell = (v: CellValue): Lesson | null => {
  const lines = cellLines(v);
  if (isEmptyLesson(lines)) return null;
  const lesson: Lesson = { subject: lines[0] };
  if (lines.length >= 2) lesson.teacher = stripHourCount(lines[1]);
  if (lines.length >= 3) lesson.room = lines[2];
  return lesson;
};

/** 교사/주간시간표 셀: [반코드, 과목] */
const parseTeacherCell = (v: CellValue): TeacherSlot | null => {
  const lines = cellLines(v);
  if (isEmptyLesson(lines)) return null;
  if (lines.length === 1) {
    // 반코드만 있거나 과목만 있는 경우
    if (/^\d{3}$/.test(lines[0])) return { classLabel: classCodeToLabel(lines[0]), subject: '' };
    return { classLabel: '', subject: lines[0] };
  }
  return { classLabel: classCodeToLabel(lines[0]), subject: lines.slice(1).join(' ') };
};

/** 특별실시간표 셀: ["반코드 과목", 교사?] */
const parseRoomCell = (v: CellValue): { classLabel: string; subject: string; teacher?: string } | null => {
  const lines = cellLines(v);
  if (isEmptyLesson(lines)) return null;
  const first = lines[0];
  const m = first.match(/^(\d{3}|\d+-\d+)\s+(.+)$/);
  const classLabel = m ? classCodeToLabel(m[1]) : '';
  const subject = m ? m[2] : first;
  const teacher = lines.length >= 2 && looksLikeTeacherName(stripHourCount(lines[1])) ? stripHourCount(lines[1]) : undefined;
  return { classLabel, subject, teacher };
};

// ---------- 그리드 조작 ----------

const ensureGrid = <T>(map: Record<string, (T | null)[][]>, key: string): (T | null)[][] => {
  if (!map[key]) map[key] = DAYS.map(() => []);
  return map[key];
};

const setSlot = <T>(grid: (T | null)[][], day: number, period: number, value: T): void => {
  while (grid[day].length < period) grid[day].push(null);
  grid[day][period - 1] = value;
};

// ---------- 블록형(학급/교사/특별실) 파싱 ----------

interface Block {
  title: string;
  headerRow: number;
  /** [period, dayCells[5]] */
  rows: { period: number; time?: string; cells: CellValue[] }[];
}

/** 시트에서 "제목 | 월 화 수 목 금" 헤더로 시작하는 블록들을 찾는다 */
const findBlocks = (grid: CellValue[][]): Block[] => {
  const blocks: Block[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const title = asText(row[0]);
    const isDayHeader =
      title.length > 0 &&
      DAY_SET.has(asText(row[1])) &&
      DAY_SET.has(asText(row[2])) &&
      DAY_SET.has(asText(row[3]));
    if (!isDayHeader) continue;
    const block: Block = { title, headerRow: r, rows: [] };
    for (let rr = r + 1; rr < grid.length; rr++) {
      const p = parsePeriodCell((grid[rr] || [])[0]);
      if (!p) break;
      block.rows.push({ period: p.period, time: p.time, cells: (grid[rr] || []).slice(1, 6) });
    }
    if (block.rows.length > 0) blocks.push(block);
  }
  return blocks;
};

/** "1학년 1반" / "1-1" → "1-1" */
const parseClassTitle = (title: string): string | null => {
  const m = title.match(/^(\d+)\s*학년\s*(\d+)\s*반$/);
  if (m) return `${parseInt(m[1], 10)}-${parseInt(m[2], 10)}`;
  if (/^\d+-\d+$/.test(title)) return classCodeToLabel(title);
  return null;
};

/** "음악실(111)" 같은 특별실 제목 → "음악실" */
const parseRoomTitle = (title: string): string | null => {
  const m = title.match(/^(.+?)\s*\((\d+)\)\s*$/);
  if (!m) return null;
  return m[1].trim();
};

type BlockKind = 'class' | 'teacher' | 'room';

const classifyBlock = (block: Block): BlockKind => {
  if (parseClassTitle(block.title)) return 'class';
  // 셀 내용으로 판별: 첫 줄이 3자리 반코드면 교사표, "반코드 과목"이면 특별실표
  let teacherish = 0;
  let roomish = 0;
  let classish = 0;
  for (const row of block.rows) {
    for (const c of row.cells) {
      const lines = cellLines(c);
      if (lines.length === 0) continue;
      if (/^\d{3}$/.test(lines[0])) teacherish++;
      else if (/^(\d{3}|\d+-\d+)\s+\S/.test(lines[0])) roomish++;
      else classish++;
    }
  }
  if (roomish > teacherish && roomish > classish) return 'room';
  if (teacherish >= roomish && teacherish > classish) return 'teacher';
  // 제목이 "이름(숫자)" 또는 특별실명(코드)인데 셀이 과목형이면: 이름이면 교사 주간표는 아님(블록형 교사표는 반코드형)
  return parseRoomTitle(block.title) && !looksLikeTeacherName(stripHourCount(block.title)) ? 'room' : 'class';
};

// ---------- 평면형(전체/주간) 파싱 ----------

interface WideLayout {
  headerRow: number; // "학급|교사, 월..." 행
  kind: 'class' | 'teacher';
  /** 열 인덱스 → { day, period } */
  columns: { col: number; day: number; period: number }[];
}

const findWideLayout = (grid: CellValue[][]): WideLayout | null => {
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const row = grid[r] || [];
    const label = asText(row[0]);
    if (label !== '학급' && label !== '교사') continue;
    // 요일 헤더 행: 병합 때문에 요일명이 시작 열에만 있음
    const periodRow = grid[r + 1] || [];
    const columns: WideLayout['columns'] = [];
    let currentDay = -1;
    for (let c = 1; c < Math.max(row.length, periodRow.length); c++) {
      const dayText = asText(row[c]);
      if (DAY_SET.has(dayText)) currentDay = (DAYS as readonly string[]).indexOf(dayText);
      // '토' 등 월~금이 아닌 헤더면 그 아래 열은 버림 (빈 칸은 병합 셀이라 직전 요일 유지)
      else if (dayText) currentDay = -1;
      const p = parseInt(asText(periodRow[c]), 10);
      if (currentDay >= 0 && Number.isFinite(p) && p >= 1 && p <= 15) {
        columns.push({ col: c, day: currentDay, period: p });
      }
    }
    if (columns.length >= 10) {
      return { headerRow: r, kind: label === '학급' ? 'class' : 'teacher', columns };
    }
  }
  return null;
};

// ---------- 병합 ----------

const mergeLessonIntoTeacher = (
  teachers: Record<string, TeacherGrid>,
  teacher: string,
  day: number,
  period: number,
  slot: TeacherSlot,
  preferExisting: boolean,
): void => {
  const grid = ensureGrid(teachers, teacher);
  const existing = grid[day]?.[period - 1];
  if (existing && preferExisting) {
    // 이미 교사표(직접 소스)에서 온 값이 있으면 유지하되, 빈 부가정보만 보충
    if (!existing.room && slot.room) existing.room = slot.room;
    if (!existing.subject && slot.subject) existing.subject = slot.subject;
    if (!existing.classLabel && slot.classLabel) existing.classLabel = slot.classLabel;
    return;
  }
  setSlot(grid, day, period, existing ? { ...existing, ...compact(slot) } : slot);
};

const compact = <T extends object>(obj: T): Partial<T> => {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v;
  }
  return out;
};

// ---------- 메인 ----------

export function parseTimetableSheets(sheets: SheetInput[]): ParseResult {
  const result: ParseResult = {
    classes: {},
    teachers: {},
    periodTimes: {},
    maxPeriod: 0,
    sources: [],
    warnings: [],
  };

  // 교사표(직접 소스)에서 온 슬롯은 역산 값보다 우선
  const directTeacherSlots = new Set<string>(); // "이름|day|period"

  // 특별실시간표 정보는 모든 시트를 읽은 뒤 "보충 전용"으로 적용한다
  // (파일 선택 순서와 무관하게 동작하고, 특별실만으로 새 시간표를 만들지 않기 위함)
  interface RoomEntry {
    room: string;
    day: number;
    period: number;
    classLabel: string;
    subject: string;
    teacher?: string;
  }
  const roomEntries: RoomEntry[] = [];

  const noteTime = (period: number, time?: string) => {
    if (time && !result.periodTimes[period]) result.periodTimes[period] = time;
    if (period > result.maxPeriod) result.maxPeriod = period;
  };

  // 1차: 블록형/평면형 시트 모두 수집
  for (const sheet of sheets) {
    const wide = findWideLayout(sheet.grid);
    if (wide) {
      const kindLabel = wide.kind === 'class' ? '전체시간표(반×주간)' : '주간시간표(교사×주간)';
      result.sources.push(`${sheet.name}: ${kindLabel}`);
      for (let r = wide.headerRow + 2; r < sheet.grid.length; r++) {
        const row = sheet.grid[r] || [];
        const rawLabel = asText(row[0]);
        if (!rawLabel) continue;
        if (wide.kind === 'class') {
          const classLabel = classCodeToLabel(rawLabel);
          const grid = ensureGrid(result.classes, classLabel);
          for (const { col, day, period } of wide.columns) {
            noteTime(period);
            const lesson = parseClassCell(row[col]);
            if (lesson) setSlot(grid, day, period, lesson);
          }
        } else {
          const teacher = stripHourCount(rawLabel);
          if (!looksLikeTeacherName(teacher)) {
            result.warnings.push(`교사 이름으로 인식하지 못해 건너뜀: "${rawLabel}"`);
            continue;
          }
          for (const { col, day, period } of wide.columns) {
            noteTime(period);
            const slot = parseTeacherCell(row[col]);
            if (slot) {
              mergeLessonIntoTeacher(result.teachers, teacher, day, period, slot, false);
              directTeacherSlots.add(`${teacher}|${day}|${period}`);
            }
          }
        }
      }
      continue;
    }

    const blocks = findBlocks(sheet.grid);
    if (blocks.length === 0) continue;
    const kinds = new Set(blocks.map(classifyBlock));
    result.sources.push(`${sheet.name}: 블록형(${Array.from(kinds).join(',')}) ${blocks.length}개`);

    for (const block of blocks) {
      const kind = classifyBlock(block);
      if (kind === 'class') {
        const classLabel = parseClassTitle(block.title) ?? classCodeToLabel(block.title);
        const grid = ensureGrid(result.classes, classLabel);
        for (const row of block.rows) {
          noteTime(row.period, row.time);
          row.cells.forEach((c, day) => {
            const lesson = parseClassCell(c);
            if (lesson) setSlot(grid, day, row.period, lesson);
          });
        }
      } else if (kind === 'teacher') {
        const teacher = stripHourCount(block.title);
        if (!looksLikeTeacherName(teacher)) {
          result.warnings.push(`교사 블록 제목이 이름 같지 않음: "${block.title}"`);
          continue;
        }
        for (const row of block.rows) {
          noteTime(row.period, row.time);
          row.cells.forEach((c, day) => {
            const slot = parseTeacherCell(c);
            if (slot) {
              mergeLessonIntoTeacher(result.teachers, teacher, day, row.period, slot, true);
              directTeacherSlots.add(`${teacher}|${day}|${row.period}`);
            }
          });
        }
      } else {
        const room = parseRoomTitle(block.title) ?? block.title;
        for (const row of block.rows) {
          noteTime(row.period, row.time);
          row.cells.forEach((c, day) => {
            const parsed = parseRoomCell(c);
            if (!parsed) return;
            roomEntries.push({
              room,
              day,
              period: row.period,
              classLabel: parsed.classLabel,
              subject: parsed.subject,
              teacher: parsed.teacher,
            });
          });
        }
      }
    }
  }

  // 2차: 반 시간표에서 교사 시간표 역산(교사표에 없는 슬롯 보충)
  for (const [classLabel, grid] of Object.entries(result.classes)) {
    grid.forEach((dayRow, day) => {
      dayRow.forEach((lesson, idx) => {
        if (!lesson || !lesson.teacher) return;
        const period = idx + 1;
        const teacher = lesson.teacher;
        if (!looksLikeTeacherName(teacher)) return;
        const slot: TeacherSlot = compact({
          classLabel,
          subject: lesson.subject,
          room: lesson.room,
        }) as TeacherSlot;
        mergeLessonIntoTeacher(
          result.teachers,
          teacher,
          day,
          period,
          slot,
          directTeacherSlots.has(`${teacher}|${day}|${period}`),
        );
      });
    });
  }

  // 2.5차: 교사 시간표에서 반 시간표 역산
  // (교사시간표/주간시간표만 올려도 반 시간표가 만들어지도록 — 비어 있는 슬롯만 채움)
  for (const [teacher, grid] of Object.entries(result.teachers)) {
    grid.forEach((dayRow, day) => {
      dayRow.forEach((slot, idx) => {
        if (!slot || !slot.subject) return;
        if (!slot.classLabel || !/^\d+-\d+$/.test(slot.classLabel)) return;
        const cgrid = ensureGrid(result.classes, slot.classLabel);
        const existing = cgrid[day]?.[idx];
        if (!existing) {
          setSlot(
            cgrid,
            day,
            idx + 1,
            compact({ subject: slot.subject, teacher, room: slot.room }) as Lesson,
          );
        }
      });
    });
  }

  // 3차: 반 시간표 셀에 교사 정보가 없는데 교사표에서 알 수 있으면 보충
  const classSlotTeacher = new Map<string, string>(); // "반|day|period" → 교사
  for (const [teacher, grid] of Object.entries(result.teachers)) {
    grid.forEach((dayRow, day) => {
      dayRow.forEach((slot, idx) => {
        if (slot?.classLabel) classSlotTeacher.set(`${slot.classLabel}|${day}|${idx + 1}`, teacher);
      });
    });
  }
  for (const [classLabel, grid] of Object.entries(result.classes)) {
    grid.forEach((dayRow, day) => {
      dayRow.forEach((lesson, idx) => {
        if (lesson && !lesson.teacher) {
          const t = classSlotTeacher.get(`${classLabel}|${day}|${idx + 1}`);
          if (t) lesson.teacher = t;
        }
      });
    });
  }

  // 4차: 특별실 정보를 기존 슬롯에만 보충 (새 그리드/슬롯은 만들지 않음)
  for (const e of roomEntries) {
    const lesson = result.classes[e.classLabel]?.[e.day]?.[e.period - 1];
    if (lesson) {
      if (!lesson.room) lesson.room = e.room;
      if (!lesson.teacher && e.teacher) lesson.teacher = e.teacher;
    }
    if (e.teacher && result.teachers[e.teacher]) {
      const slot = result.teachers[e.teacher][e.day]?.[e.period - 1];
      if (slot && !slot.room) slot.room = e.room;
    }
  }
  if (
    roomEntries.length > 0 &&
    Object.keys(result.classes).length === 0 &&
    Object.keys(result.teachers).length === 0
  ) {
    result.warnings.push(
      '특별실시간표만으로는 시간표를 등록할 수 없어요. 학급·교사·전체·주간 시간표 파일을 함께 올려주세요.',
    );
  }

  return result;
}

/** 정렬용: "1-2" < "1-10" < "3-1" */
export const compareClassLabels = (a: string, b: string): number => {
  const pa = a.split('-').map((n) => parseInt(n, 10));
  const pb = b.split('-').map((n) => parseInt(n, 10));
  if (Number.isFinite(pa[0]) && Number.isFinite(pb[0]) && pa[0] !== pb[0]) return pa[0] - pb[0];
  if (Number.isFinite(pa[1]) && Number.isFinite(pb[1])) return pa[1] - pb[1];
  return a.localeCompare(b, 'ko');
};

// ======================================================================
// 가져오기(새 개인 시간표)용 추출 — 칸 단위 출처
// - 파일에 실제로 있던 칸만 ImportRow로 만든다(반표↔교사표 역산, 특별실 보충 없음).
// - 토·일 열, 8교시 이상, 분반 접두어('A_영어') 그대로 둔다(cleanSubject 적용 안 함).
// - 시트 유형은 자동 판별하되 교사가 화면에서 바꿀 수 있다(kinds 옵션).
// - 어느 칸이 같은 수업인지 합치는 일은 매칭 단계(importMatch)가 한다.
// ======================================================================

/** 병합 셀(시트 절대 좌표, 0부터) — SheetJS ws['!merges'] 형식 */
export interface MergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface ImportSheetInput extends SheetInput {
  /** 시트 사용 범위 시작(0부터, SheetJS decode_range(ws['!ref']).s) — grid[0][0]의 원본 위치 */
  origin?: { r: number; c: number };
  /** 병합 셀. 한 줄(세로 또는 가로)로 이어진 작은 병합만 '여러 교시로 이어진 수업'으로 읽는다 */
  merges?: MergeRange[];
}

/** 교사가 고른 시트 유형. 'table'은 열 매핑(mapTableRows)으로 따로 읽으므로 여기서는 건너뜀 */
export type ImportSheetChoice = 'auto' | 'class' | 'teacher' | 'room' | 'table' | 'skip';

export interface SheetDetection {
  name: string;
  layout: 'block' | 'wide' | 'none';
  /** 자동 판별 결과(확정 아님) */
  detected: 'class' | 'teacher' | 'room' | 'mixed' | 'unknown';
  blocks: { class: number; teacher: number; room: number };
  rowCount: number;
  /** 판별 근거(화면 표시용) */
  note: string;
}

export interface ImportWarning {
  sheet: string;
  row?: number;
  col?: number;
  message: string;
}

export interface ImportExtractResult {
  rows: ImportRow[];
  sheets: SheetDetection[];
  warnings: ImportWarning[];
  /** 블록형 교시 칸에 적힌 시각(처음 본 값) */
  periodTimes: Record<number, { start: string; end?: string }>;
  /** 병합 셀이라 위 칸 값으로 읽은 칸 수 */
  mergedCells: number;
}

type ImportCellKind = 'class' | 'teacher' | 'room';

const ALL_DAYS = ['월', '화', '수', '목', '금', '토', '일'] as const;

/** 요일 머리글 → ISO 요일(월=1 … 일=7), 아니면 0. '월', '월요일', '(월)' */
const dayOfHeader = (v: CellValue): number => {
  const t = asText(v).replace(/[()\s]/g, '').replace(/요일$/, '');
  const i = (ALL_DAYS as readonly string[]).indexOf(t);
  return i >= 0 ? i + 1 : 0;
};

/** "1교시\n(09:10)", "1교시(09:10~09:55)" → 교시·시작·종료 */
const parsePeriodCellEx = (v: CellValue): { period: number; start?: string; end?: string } | null => {
  const t = asText(v);
  const m = t.match(/^(\d+)\s*교시/);
  if (!m) return null;
  const period = parseInt(m[1], 10);
  if (!(period >= 1)) return null;
  const tm = t.slice(m[0].length).match(/(\d{1,2}:\d{2})(?:\s*[~\-–]\s*(\d{1,2}:\d{2}))?/);
  const out: { period: number; start?: string; end?: string } = { period };
  const start = tm ? parseTimeText(tm[1]) : null;
  const end = tm && tm[2] ? parseTimeText(tm[2]) : null;
  if (start) out.start = start;
  if (end) out.end = end;
  return out;
};

interface ImportBlock {
  title: string;
  /** 머리글 행(grid 인덱스) */
  titleRow: number;
  dayCols: { col: number; weekday: number }[];
  rows: { r: number; period: number; start?: string; end?: string }[];
}

/** "제목 | 월 화 수 …(토·일 포함)" 머리글로 시작하는 블록들 */
const findImportBlocks = (grid: CellValue[][]): ImportBlock[] => {
  const blocks: ImportBlock[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const title = asText(row[0]);
    if (!title || !(dayOfHeader(row[1]) && dayOfHeader(row[2]) && dayOfHeader(row[3]))) continue;
    const dayCols: ImportBlock['dayCols'] = [];
    for (let c = 1; c < row.length; c++) {
      const wd = dayOfHeader(row[c]);
      if (!wd) break;
      dayCols.push({ col: c, weekday: wd });
    }
    const rows: ImportBlock['rows'] = [];
    for (let rr = r + 1; rr < grid.length; rr++) {
      const p = parsePeriodCellEx((grid[rr] || [])[0]);
      if (!p) break;
      rows.push({ r: rr, ...p });
    }
    if (rows.length > 0) blocks.push({ title, titleRow: r, dayCols, rows });
  }
  return blocks;
};

/** 기존 블록 판별(classifyBlock)을 그대로 쓰기 위한 변환 */
const toLegacyBlock = (b: ImportBlock, grid: CellValue[][]): Block => ({
  title: b.title,
  headerRow: b.titleRow,
  rows: b.rows.map((row) => ({
    period: row.period,
    time: row.start,
    cells: b.dayCols.map((dc) => (grid[row.r] || [])[dc.col]),
  })),
});

const wideKindOf = (label: string): ImportCellKind | null => {
  switch (label.replace(/\s+/g, '')) {
    case '학급':
    case '학년반':
      return 'class';
    case '교사':
    case '교사명':
    case '선생님':
      return 'teacher';
    case '특별실':
    case '교실':
      return 'room';
    default:
      return null;
  }
};

interface ImportWide {
  headerRow: number;
  label: string;
  kind: ImportCellKind;
  columns: { col: number; weekday: number; period: number }[];
}

/** 평면형(행=반/교사/교실, 열=요일×교시). 토·일 열도 버리지 않음 */
const findImportWide = (grid: CellValue[][]): ImportWide | null => {
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const row = grid[r] || [];
    const label = asText(row[0]);
    const kind = wideKindOf(label);
    if (!kind) continue;
    const periodRow = grid[r + 1] || [];
    const columns: ImportWide['columns'] = [];
    let currentDay = 0;
    for (let c = 1; c < Math.max(row.length, periodRow.length); c++) {
      const wd = dayOfHeader(row[c]);
      if (wd) currentDay = wd;
      // 요일이 아닌 머리글이면 그 아래 열은 수업 칸이 아님(빈 칸은 병합 셀이라 직전 요일 유지)
      else if (asText(row[c])) currentDay = 0;
      const p = parseInt(asText(periodRow[c]), 10);
      if (currentDay && Number.isFinite(p) && p >= 1 && p <= 20) columns.push({ col: c, weekday: currentDay, period: p });
    }
    if (columns.length >= 10) return { headerRow: r, label, kind, columns };
  }
  return null;
};

interface SheetScan {
  detection: SheetDetection;
  wide: ImportWide | null;
  blocks: ImportBlock[];
  blockKinds: BlockKind[];
}

/** 왼쪽에 빈 열이 있으면(내용이 B열부터 시작) 잘라 내고 origin을 옮김 — 블록 제목은 첫 열에 있어야 하므로 */
const trimLeadingEmptyCols = (sheet: ImportSheetInput): ImportSheetInput => {
  const grid = sheet.grid || [];
  let first = Infinity;
  for (const row of grid) {
    if (!row) continue;
    for (let c = 0; c < row.length && c < first; c++) {
      if (asText(row[c])) {
        first = c;
        break;
      }
    }
  }
  if (!Number.isFinite(first) || first === 0) return sheet;
  return {
    ...sheet,
    grid: grid.map((row) => (row ? row.slice(first) : row)),
    origin: { r: sheet.origin?.r ?? 0, c: (sheet.origin?.c ?? 0) + first },
  };
};

const scanImportSheet = (sheet: ImportSheetInput): SheetScan => {
  const grid = sheet.grid || [];
  const base = { name: sheet.name, rowCount: grid.length, blocks: { class: 0, teacher: 0, room: 0 } };
  const wide = findImportWide(grid);
  if (wide) {
    const kindKo = wide.kind === 'class' ? '학급' : wide.kind === 'teacher' ? '교사' : '특별실';
    return {
      detection: {
        ...base,
        layout: 'wide',
        detected: wide.kind,
        note: `'${wide.label}' 머리글 + 요일·교시 열 ${wide.columns.length}개 — 행마다 ${kindKo} 하나`,
      },
      wide,
      blocks: [],
      blockKinds: [],
    };
  }
  const blocks = findImportBlocks(grid);
  if (blocks.length === 0) {
    return {
      detection: {
        ...base,
        layout: 'none',
        detected: 'unknown',
        note: "시간표 블록·평면형 머리글을 찾지 못했어요. 한 행에 수업 하나씩 적힌 표라면 '표 형식'으로 열을 지정해 주세요.",
      },
      wide: null,
      blocks: [],
      blockKinds: [],
    };
  }
  const blockKinds = blocks.map((b) => classifyBlock(toLegacyBlock(b, grid)));
  const counts = { class: 0, teacher: 0, room: 0 };
  blockKinds.forEach((k) => {
    counts[k]++;
  });
  const kindsFound = (['class', 'teacher', 'room'] as const).filter((k) => counts[k] > 0);
  return {
    detection: {
      ...base,
      blocks: counts,
      layout: 'block',
      detected: kindsFound.length === 1 ? kindsFound[0] : 'mixed',
      note: `블록 ${blocks.length}개 (학급 ${counts.class} · 교사 ${counts.teacher} · 특별실 ${counts.room})`,
    },
    wide: null,
    blocks,
    blockKinds,
  };
};

/** 시트별 자료 유형 자동 판별(화면에서 교사가 확인·수정) */
export function detectImportSheets(sheets: ImportSheetInput[]): SheetDetection[] {
  return sheets.map((s) => scanImportSheet(trimLeadingEmptyCols(s)).detection);
}

/** 병합 셀 → 덮인 칸 'r,c' → 왼쪽 위 칸 [r, c] (grid 좌표). 한 줄로 이어진 작은 병합만 */
const buildMergeLookup = (sheet: ImportSheetInput): Map<string, [number, number]> => {
  const map = new Map<string, [number, number]>();
  if (!sheet.merges || sheet.merges.length === 0) return map;
  const or = sheet.origin?.r ?? 0;
  const oc = sheet.origin?.c ?? 0;
  for (const m of sheet.merges) {
    const r0 = m.s.r - or;
    const c0 = m.s.c - oc;
    const r1 = m.e.r - or;
    const c1 = m.e.c - oc;
    const cells = (r1 - r0 + 1) * (c1 - c0 + 1);
    // 제목·머리글처럼 큰 병합이나 2차원 병합은 수업 칸이 아님
    if (cells <= 1 || cells > 8 || (r0 !== r1 && c0 !== c1) || r0 < 0 || c0 < 0) continue;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (r !== r0 || c !== c0) map.set(`${r},${c}`, [r0, c0]);
      }
    }
  }
  return map;
};

const classLabelFromCode = (s: string): string | null =>
  /^(\d{3}|\d{1,2}-\d{1,2}|\d{1,2}\s*학년\s*\d{1,2}\s*반)$/.test(s.trim()) ? normalizeClassLabel(s) : null;

type CellFields = Omit<ImportRow, 'sourceKind' | 'sheet' | 'row' | 'col' | 'weekday' | 'period'>;

/** 칸 하나 → 그 칸에 실제로 적힌 필드만 */
const importFieldsFromCell = (
  kind: ImportCellKind,
  owner: string,
  v: CellValue,
  warn: (message: string) => void,
): CellFields | null => {
  const lines = cellLines(v);
  if (lines.length === 0) return null;
  if (kind === 'class') {
    const out: CellFields = { subject: normSpace(lines[0]), classLabel: owner };
    if (lines[1]) out.teacher = normalizeTeacherName(lines[1]);
    if (lines[2]) out.room = normSpace(lines[2]);
    if (lines.length > 3) warn(`칸에 줄이 ${lines.length}개라 4번째 줄부터는 읽지 않았어요: "${lines.slice(3).join(' / ')}"`);
    return out;
  }
  if (kind === 'teacher') {
    const label = classLabelFromCode(lines[0]);
    if (lines.length === 1) {
      if (label) {
        warn(`반 코드(${lines[0]})만 있고 과목이 없어요.`);
        return { subject: '', classLabel: label, teacher: owner };
      }
      return { subject: normSpace(lines[0]), teacher: owner };
    }
    if (lines.length > 2) warn(`칸에 줄이 ${lines.length}개라 2번째 줄부터를 과목으로 합쳐 읽었어요: "${lines.slice(1).join(' / ')}"`);
    return { subject: normSpace(lines.slice(1).join(' ')), classLabel: label ?? normSpace(lines[0]), teacher: owner };
  }
  const m = lines[0].match(/^(\d{3}|\d+-\d+)\s+(.+)$/);
  const out: CellFields = { subject: normSpace(m ? m[2] : lines[0]), room: owner };
  if (m) out.classLabel = normalizeClassLabel(m[1]) ?? m[1];
  if (lines[1]) {
    const t = normalizeTeacherName(lines[1]);
    if (looksLikeTeacherName(t)) out.teacher = t;
    else warn(`둘째 줄 '${lines[1]}'을(를) 교사 이름으로 읽지 못해 넣지 않았어요.`);
  }
  if (lines.length > 2) warn(`칸에 줄이 ${lines.length}개라 3번째 줄부터는 읽지 않았어요: "${lines.slice(2).join(' / ')}"`);
  return out;
};

/**
 * 시간표 시트들 → 칸 단위 ImportRow + 시트 판별 결과 + 경고.
 * opts.kinds: 시트 이름 → 교사가 고른 유형('auto'가 기본, 'table'·'skip'은 여기서 건너뜀)
 */
export function extractImportRowsWithReport(
  sheets: ImportSheetInput[],
  opts: { kinds?: Record<string, ImportSheetChoice> } = {},
): ImportExtractResult {
  const result: ImportExtractResult = { rows: [], sheets: [], warnings: [], periodTimes: {}, mergedCells: 0 };
  const timeConflictWarned = new Set<number>();

  for (const input of sheets) {
    const sheet = trimLeadingEmptyCols(input);
    const grid = sheet.grid || [];
    const scan = scanImportSheet(sheet);
    result.sheets.push(scan.detection);
    const choice: ImportSheetChoice =
      opts.kinds && Object.prototype.hasOwnProperty.call(opts.kinds, sheet.name) ? opts.kinds[sheet.name] : 'auto';
    if (choice === 'skip' || choice === 'table') continue;

    const or = sheet.origin?.r ?? 0;
    const oc = sheet.origin?.c ?? 0;
    const rowNo = (r: number) => r + or + 1;
    const colNo = (c: number) => c + oc + 1;
    const warnAt = (r?: number, c?: number) => (message: string) =>
      result.warnings.push({
        sheet: sheet.name,
        ...(r !== undefined ? { row: rowNo(r) } : {}),
        ...(c !== undefined ? { col: colNo(c) } : {}),
        message,
      });
    const merges = buildMergeLookup(sheet);
    /** 빈 칸이 병합으로 덮였고 왼쪽 위 칸이 같은 블록의 수업 칸이면 그 값 */
    const valueAt = (r: number, c: number, sameGroup: (r0: number, c0: number) => boolean) => {
      const v = (grid[r] || [])[c];
      if (asText(v)) return { v, merged: false };
      const tl = merges.get(`${r},${c}`);
      if (tl && sameGroup(tl[0], tl[1])) return { v: (grid[tl[0]] || [])[tl[1]], merged: true };
      return { v, merged: false };
    };
    const push = (
      kind: ImportCellKind,
      r: number,
      c: number,
      weekday: number,
      period: number,
      fields: CellFields,
      time?: { start?: string; end?: string },
    ) => {
      const row: ImportRow = {
        sourceKind: kind,
        sheet: sheet.name,
        row: rowNo(r),
        col: colNo(c),
        weekday: weekday as Weekday,
        period,
        subject: fields.subject,
      };
      if (fields.section) row.section = fields.section;
      if (fields.teacher) row.teacher = fields.teacher;
      if (fields.classLabel) row.classLabel = fields.classLabel;
      if (fields.room) row.room = fields.room;
      if (time?.start) row.start = time.start;
      if (time?.end) row.end = time.end;
      result.rows.push(row);
    };

    if (scan.wide) {
      const wide = scan.wide;
      const kind: ImportCellKind = choice === 'auto' ? wide.kind : choice;
      const dataCols = new Set(wide.columns.map((x) => x.col));
      for (let r = wide.headerRow + 2; r < grid.length; r++) {
        const rawLabel = asText((grid[r] || [])[0]);
        if (!rawLabel) continue;
        if (wideKindOf(rawLabel)) {
          r++; // 여러 쪽으로 나뉜 표의 반복 머리글(다음 행은 교시 번호)
          continue;
        }
        let owner: string;
        if (kind === 'class') owner = normalizeClassLabel(rawLabel) ?? normSpace(rawLabel);
        else if (kind === 'teacher') {
          owner = normalizeTeacherName(rawLabel);
          if (choice === 'auto' && !looksLikeTeacherName(owner)) {
            warnAt(r, 0)(`교사 이름으로 인식하지 못해 이 행을 건너뜀: "${rawLabel}" (시트 유형을 '교사'로 지정하면 그대로 읽어요)`);
            continue;
          }
        } else owner = normSpace(rawLabel);
        for (const { col, weekday, period } of wide.columns) {
          const { v, merged } = valueAt(r, col, (r0, c0) => r0 === r && dataCols.has(c0));
          const fields = importFieldsFromCell(kind, owner, v, warnAt(r, col));
          if (!fields) continue;
          if (merged) result.mergedCells++;
          push(kind, r, col, weekday, period, fields);
        }
      }
      continue;
    }

    if (scan.blocks.length === 0) {
      if (choice !== 'auto') {
        warnAt()(`'${sheet.name}'에서 시간표 블록을 찾지 못했어요. 한 행에 수업 하나씩 적힌 표라면 '표 형식'으로 바꿔 열을 지정해 주세요.`);
      }
      continue;
    }

    scan.blocks.forEach((block, bi) => {
      const kind: ImportCellKind = choice === 'auto' ? scan.blockKinds[bi] : choice;
      let owner: string;
      if (kind === 'class') {
        owner = parseClassTitle(block.title) ?? normalizeClassLabel(block.title) ?? normSpace(block.title);
      } else if (kind === 'teacher') {
        owner = normalizeTeacherName(block.title);
        if (choice === 'auto' && !looksLikeTeacherName(owner)) {
          warnAt(block.titleRow, 0)(
            `교사 블록 제목이 이름 같지 않아 건너뜀: "${block.title}" (시트 유형을 '교사'로 지정하면 그대로 읽어요)`,
          );
          return;
        }
      } else owner = parseRoomTitle(block.title) ?? normSpace(block.title);

      const periodRows = new Set(block.rows.map((x) => x.r));
      for (const prow of block.rows) {
        if (prow.start) {
          const seen = result.periodTimes[prow.period];
          if (!seen) result.periodTimes[prow.period] = prow.end ? { start: prow.start, end: prow.end } : { start: prow.start };
          else if ((seen.start !== prow.start || (prow.end && seen.end && seen.end !== prow.end)) && !timeConflictWarned.has(prow.period)) {
            timeConflictWarned.add(prow.period);
            warnAt(prow.r, 0)(`${prow.period}교시 시각이 블록마다 달라요(${seen.start} / ${prow.start}). 칸마다 적힌 시각을 그대로 썼어요.`);
          }
        }
        for (const dc of block.dayCols) {
          const { v, merged } = valueAt(prow.r, dc.col, (r0, c0) => c0 === dc.col && periodRows.has(r0));
          const fields = importFieldsFromCell(kind, owner, v, warnAt(prow.r, dc.col));
          if (!fields) continue;
          if (merged) result.mergedCells++;
          push(kind, prow.r, dc.col, dc.weekday, prow.period, fields, { start: prow.start, end: prow.end });
        }
      }
    });
  }
  return result;
}

/** 시간표 시트들 → 칸 단위 ImportRow(파일에 실제로 있던 칸만). 판별 결과·경고가 필요하면 extractImportRowsWithReport */
export function extractImportRows(
  sheets: ImportSheetInput[],
  opts: { kinds?: Record<string, ImportSheetChoice> } = {},
): ImportRow[] {
  return extractImportRowsWithReport(sheets, opts).rows;
}

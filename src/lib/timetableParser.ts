// 시간표 엑셀(컴시간 내보내기) 파서.
// SheetJS 등 외부 의존성 없이 "셀 그리드(배열의 배열)"만 입력으로 받는다.
// 지원 형식 (모두 자동 감지, 여러 파일을 섞어 넣어도 병합됨):
//  - 학급시간표: 반별 블록, 셀 = "과목\n교사(\n특별실)"
//  - 교사시간표: 교사별 블록, 셀 = "반코드\n과목" (301 → 3-1)
//  - 특별실시간표: 특별실별 블록, 셀 = "반코드 과목\n교사"
//  - 전체시간표: 행=반, 열=요일×교시 평면화, 셀 = "과목\n교사(\n특별실)"
//  - 주간시간표: 행=교사("이름(총시수)"), 열=요일×교시 평면화, 셀 = "반코드\n과목"

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

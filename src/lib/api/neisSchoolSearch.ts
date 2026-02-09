// src/lib/api/neisSchoolSearch.ts
export type NeisSchool = {
  ATPT_OFCDC_SC_CODE: string; // 교육청 코드
  SD_SCHUL_CODE: string; // 학교 코드
  SCHUL_NM: string; // 학교명
  ORG_RDNMA?: string; // 도로명 주소(있을 수도)
};

const NEIS_KEY = "99e3673b99214b9daaf702335ff72339"; // ✅ 네 인증키

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickArray<T>(maybe: any): T[] {
  if (Array.isArray(maybe)) return maybe as T[];
  if (maybe == null) return [];
  return [maybe as T];
}

export async function searchSchools(query: string): Promise<NeisSchool[]> {
  const q = query.trim();
  if (!q) return [];

  const url =
    "https://open.neis.go.kr/hub/schoolInfo" +
    `?KEY=${encodeURIComponent(NEIS_KEY)}` +
    "&Type=json" +
    "&pIndex=1" +
    "&pSize=50" +
    `&SCHUL_NM=${encodeURIComponent(q)}`;

  const res = await fetch(url);
  const data = await res.json();

  // NEIS 응답 구조: { schoolInfo: [ { head: ... }, { row: [...] } ] }
  const schoolInfo = data?.schoolInfo;
  if (!Array.isArray(schoolInfo) || schoolInfo.length < 2) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = pickArray<any>(schoolInfo[1]?.row);

  return rows.map((r) => ({
    ATPT_OFCDC_SC_CODE: String(r.ATPT_OFCDC_SC_CODE ?? ""),
    SD_SCHUL_CODE: String(r.SD_SCHUL_CODE ?? ""),
    SCHUL_NM: String(r.SCHUL_NM ?? ""),
    ORG_RDNMA: r.ORG_RDNMA ? String(r.ORG_RDNMA) : undefined,
  }));
}

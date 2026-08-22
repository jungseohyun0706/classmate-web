// NEIS 전체 학교 목록 덤프 (선택 도구 — 앱 동작에는 불필요)
// 사용법: NEIS_SERVICE_KEY=... node scripts/fetch-neis.js
import fs from 'fs';

const KEY = process.env.NEIS_SERVICE_KEY;
if (!KEY) { console.error('NEIS_SERVICE_KEY missing'); process.exit(1); }

const URL = (page = 1, pSize = 100) =>
  `https://open.neis.go.kr/hub/schoolInfo?Type=json&pIndex=${page}&pSize=${pSize}&KEY=${KEY}`;

(async () => {
  let page = 1; const all = [];
  while (true) {
    const res = await fetch(URL(page)); // Node 18+ 내장 fetch
    if (!res.ok) { console.error('NEIS fetch failed', res.status); break; }
    const j = await res.json();
    if (!j || !j.schoolInfo || j.schoolInfo.length === 0) { console.log('no more data'); break; }
    const data = j.schoolInfo[1].row;
    console.log('fetched page', page, 'count', data.length);
    all.push(...data);
    if (data.length < 100) break;
    page++;
  }
  fs.writeFileSync('scripts/neis-schools.json', JSON.stringify(all, null, 2));
  console.log('saved', all.length, 'schools to scripts/neis-schools.json');
})();

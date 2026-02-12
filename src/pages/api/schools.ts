import { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const q = (req.query.q as string || '').toLowerCase();
  const path = 'scripts/neis-schools.json';
  if (!fs.existsSync(path)) return res.status(500).json({ error: 'schools data missing' });
  const raw = fs.readFileSync(path, 'utf8');
  const all = JSON.parse(raw);
  // NEIS returns various field names; normalize name field
  const mapped = all.map((s: any) => ({
    id: s.SCHOOL_ID || s.SCHUL_CODE || s.id || '',
    name: s.KOR_NM || s.SCHOOL_NAME || s.name || '',
    region: s.ATPT_OFCDC_SC_CODE || s.region || '',
    raw: s
  }));
  if (!q) return res.status(200).json(mapped.slice(0, 50));
  const filtered = mapped.filter((s: any) => (s.name || '').toLowerCase().includes(q) || (s.id || '').toLowerCase().includes(q));
  res.status(200).json(filtered.slice(0, 100));
}

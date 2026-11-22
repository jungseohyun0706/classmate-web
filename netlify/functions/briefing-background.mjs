import { timingSafeEqual } from 'node:crypto';
import { briefingPaths, briefingSecret } from '../briefings.mjs';

export default async (request, { site }) => {
  if (request.method !== 'POST') return;

  const provided = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${briefingSecret()}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return;

  const { period } = await request.json();
  if (period !== 'morning' && period !== 'evening') return;

  // The API may already have sent notifications if the connection drops.
  // Don't ask Netlify to retry a delivery whose outcome is uncertain.
  try {
    const response = await fetch(new URL(briefingPaths[period], site.url), {
      headers: { Authorization: `Bearer ${briefingSecret()}` },
      redirect: 'error',
      signal: AbortSignal.timeout(70_000),
    });
    if (!response.ok) {
      console.error(`Classmate ${period} briefing returned HTTP ${response.status}`);
    }
  } catch {
    console.error(`Could not confirm the outcome of the Classmate ${period} briefing`);
  }
};

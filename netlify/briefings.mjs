export const briefingPaths = {
  morning: '/api/cron/morning-brief',
  evening: '/api/cron/evening-brief',
};

export function briefingSecret() {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET is required to run Classmate briefings.');
  return secret;
}

export async function enqueueBriefing(period, { site }) {
  const target = new URL('/.netlify/functions/briefing-background', site.url);
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${briefingSecret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ period }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 202) {
    throw new Error(`Failed to queue the ${period} briefing: HTTP ${response.status}`);
  }
}

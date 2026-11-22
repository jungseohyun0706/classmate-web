import { enqueueBriefing } from '../briefings.mjs';

export const config = { schedule: '0 12 * * 0-4' };

export default async (_request, context) => enqueueBriefing('evening', context);

import { enqueueBriefing } from '../briefings.mjs';

export const config = { schedule: '0 23 * * 0-4' };

export default async (_request, context) => enqueueBriefing('morning', context);

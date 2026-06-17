import { registerSourceClient } from '../../core/sync-orchestrator.js';
import { GoogleCalendarSourceClient } from './sync.js';

export const googleCalendarClient = new GoogleCalendarSourceClient();

/**
 * Register the Google Calendar SourceClient with the orchestrator.
 * Called once at startup from src/index.ts when Google env vars are present.
 */
export function registerGoogleCalendar(): void {
  registerSourceClient(googleCalendarClient);
}

export { GoogleCalendarSourceClient } from './sync.js';

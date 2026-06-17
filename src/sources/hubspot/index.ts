import { registerSourceClient } from '../../core/sync-orchestrator.js';
import { HubspotSourceClient } from './sync.js';

export const hubspotClient = new HubspotSourceClient();

/**
 * Register the HubSpot SourceClient with the orchestrator.
 * Called once at startup from src/index.ts.
 */
export function registerHubspot(): void {
  registerSourceClient(hubspotClient);
}

export { HubspotSourceClient } from './sync.js';

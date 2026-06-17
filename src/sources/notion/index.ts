import { registerSourceClient } from '../../core/sync-orchestrator.js';
import { NotionSourceClient } from './sync.js';

export const notionClient = new NotionSourceClient();

/**
 * Register the Notion SourceClient with the orchestrator.
 * Called once at startup from src/index.ts when Notion env vars are present.
 */
export function registerNotion(): void {
  registerSourceClient(notionClient);
}

export { NotionSourceClient } from './sync.js';

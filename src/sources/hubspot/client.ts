import { Client } from '@hubspot/api-client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts/index.js';
import { env } from '../../config/env.js';
import { SourceApiError } from '../../core/errors.js';
import { createSourcePolicy } from '../../core/resilience.js';
import type { HubspotEntityType } from './mapper.js';

const PROPERTIES: Record<HubspotEntityType, string[]> = {
  contact: ['firstname', 'lastname', 'email', 'phone', 'lifecyclestage', 'hs_lastmodifieddate'],
  company: ['name', 'domain', 'industry', 'phone', 'city', 'state', 'country', 'hs_lastmodifieddate'],
  deal: ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'hs_lastmodifieddate'],
};

const PAGE_SIZE = 100;

let cached: Client | null = null;
function getClient(): Client {
  if (cached) return cached;
  if (!env.HUBSPOT_ACCESS_TOKEN) {
    throw new Error('HUBSPOT_ACCESS_TOKEN is not configured');
  }
  cached = new Client({ accessToken: env.HUBSPOT_ACCESS_TOKEN });
  return cached;
}

const policy = createSourcePolicy('hubspot');

interface ApiErrorShape {
  statusCode?: number;
  status?: number;
  body?: { message?: string };
  message?: string;
}

function toSourceApiError(err: unknown, entityType: HubspotEntityType): SourceApiError {
  const e = err as ApiErrorShape;
  const status = e?.statusCode ?? e?.status ?? 0;
  const message = e?.body?.message ?? e?.message ?? 'unknown HubSpot error';
  return new SourceApiError('hubspot', status, message, { entityType });
}

function getBasicApi(entityType: HubspotEntityType) {
  const c = getClient();
  if (entityType === 'contact') return c.crm.contacts.basicApi;
  if (entityType === 'company') return c.crm.companies.basicApi;
  return c.crm.deals.basicApi;
}

function getSearchApi(entityType: HubspotEntityType) {
  const c = getClient();
  if (entityType === 'contact') return c.crm.contacts.searchApi;
  if (entityType === 'company') return c.crm.companies.searchApi;
  return c.crm.deals.searchApi;
}

/**
 * Iterate ALL records of an entity type, paginating via the SDK's `after`
 * token. Used by full backfill — bypasses the Search API's 10k-record cap.
 */
export async function* listAll(
  entityType: HubspotEntityType,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const api = getBasicApi(entityType);
  let after: string | undefined;

  while (true) {
    if (signal?.aborted) return;

    const response = await policy.execute(async () => {
      try {
        return await api.getPage(PAGE_SIZE, after, PROPERTIES[entityType]);
      } catch (err) {
        throw toSourceApiError(err, entityType);
      }
    });

    for (const result of response.results) {
      yield result;
    }

    const nextAfter = response.paging?.next?.after;
    if (!nextAfter) return;
    after = nextAfter;
  }
}

/**
 * Iterate records modified at or after `since`, sorted ASC. Uses the CRM
 * Search API with `hs_lastmodifieddate GTE` filter. Caller is responsible
 * for handling the 10k-record cap (Search API limit) — see incremental
 * orchestrator notes if a window grows beyond that.
 */
export async function* searchSince(
  entityType: HubspotEntityType,
  sinceMs: number,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const api = getSearchApi(entityType);
  let after: string | undefined;

  while (true) {
    if (signal?.aborted) return;

    const response = await policy.execute(async () => {
      try {
        return await api.doSearch({
          filterGroups: [
            {
              filters: [
                {
                  propertyName: 'hs_lastmodifieddate',
                  operator: FilterOperatorEnum.Gte,
                  value: String(sinceMs),
                },
              ],
            },
          ],
          sorts: ['hs_lastmodifieddate'],
          properties: PROPERTIES[entityType],
          limit: PAGE_SIZE,
          after: after ?? '0',
        });
      } catch (err) {
        throw toSourceApiError(err, entityType);
      }
    });

    for (const result of response.results) {
      yield result;
    }

    const nextAfter = response.paging?.next?.after;
    if (!nextAfter) return;
    after = nextAfter;
  }
}

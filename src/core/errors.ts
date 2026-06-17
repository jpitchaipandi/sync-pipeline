export type ErrorCode =
  | 'SYNC_ERROR'
  | 'CURSOR_EXPIRED'
  | 'SOURCE_API_ERROR'
  | 'PAYLOAD_VALIDATION_ERROR'
  | 'DUPLICATE_WEBHOOK'
  | 'SYNC_ALREADY_RUNNING'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export class SyncError extends Error {
  override readonly name = 'SyncError';
  readonly code: ErrorCode;
  readonly context: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.context = context;
  }
}

export class CursorExpiredError extends SyncError {
  override readonly name = 'CursorExpiredError';

  constructor(source: string, context: Record<string, unknown> = {}) {
    super('CURSOR_EXPIRED', `Cursor expired for source "${source}"`, { source, ...context });
  }
}

export class SourceApiError extends SyncError {
  override readonly name = 'SourceApiError';

  constructor(source: string, status: number, message: string, context: Record<string, unknown> = {}) {
    super('SOURCE_API_ERROR', `${source} API error (${status}): ${message}`, {
      source,
      status,
      ...context,
    });
  }
}

export class PayloadValidationError extends SyncError {
  override readonly name = 'PayloadValidationError';

  constructor(source: string, recordId: string, issues: unknown) {
    super('PAYLOAD_VALIDATION_ERROR', `Payload validation failed for ${source}#${recordId}`, {
      source,
      recordId,
      issues,
    });
  }
}

export class DuplicateWebhookError extends SyncError {
  override readonly name = 'DuplicateWebhookError';

  constructor(eventId: string, source: string) {
    super('DUPLICATE_WEBHOOK', `Duplicate webhook delivery: ${source}/${eventId}`, {
      eventId,
      source,
    });
  }
}

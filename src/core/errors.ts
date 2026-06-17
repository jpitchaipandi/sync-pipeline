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
  readonly code: ErrorCode;
  readonly context: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.context = context;
  }
}

export class CursorExpiredError extends SyncError {
  constructor(source: string, context: Record<string, unknown> = {}) {
    super('CURSOR_EXPIRED', `Cursor expired for source "${source}"`, { source, ...context });
    this.name = 'CursorExpiredError';
  }
}

export class SourceApiError extends SyncError {
  constructor(source: string, status: number, message: string, context: Record<string, unknown> = {}) {
    super('SOURCE_API_ERROR', `${source} API error (${status}): ${message}`, {
      source,
      status,
      ...context,
    });
    this.name = 'SourceApiError';
  }
}

export class PayloadValidationError extends SyncError {
  constructor(source: string, recordId: string, issues: unknown) {
    super('PAYLOAD_VALIDATION_ERROR', `Payload validation failed for ${source}#${recordId}`, {
      source,
      recordId,
      issues,
    });
    this.name = 'PayloadValidationError';
  }
}

export class DuplicateWebhookError extends SyncError {
  constructor(eventId: string, source: string) {
    super('DUPLICATE_WEBHOOK', `Duplicate webhook delivery: ${source}/${eventId}`, {
      eventId,
      source,
    });
    this.name = 'DuplicateWebhookError';
  }
}

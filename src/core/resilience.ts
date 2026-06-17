import {
  ConsecutiveBreaker,
  ExponentialBackoff,
  bulkhead,
  circuitBreaker,
  handleAll,
  handleWhen,
  retry,
  wrap,
  type IPolicy,
} from 'cockatiel';
import { CursorExpiredError, PayloadValidationError } from './errors.js';
import type { SourceId } from '../sources/types.js';

/**
 * Default resilience policy for source API calls.
 *
 * Layers (innermost → outermost when executing):
 *   retry          — exponential backoff with jitter; 3 attempts max.
 *                    Skips CursorExpiredError and PayloadValidationError
 *                    (terminal — orchestrator handles them directly).
 *   circuit breaker — opens after 5 consecutive failures; 30 s cooldown.
 *                    Prevents thundering-herd against a sick source API.
 *   bulkhead       — caps concurrent in-flight calls to 3 (queue 10).
 *                    Protects the source from our own overload.
 *
 * Usage from a source client (Phases 3-5):
 *   const policy = createSourcePolicy('hubspot');
 *   const data = await policy.execute(() => http.get('/contacts'));
 */
export function createSourcePolicy(_source: SourceId): IPolicy {
  const retryPolicy = retry(
    handleWhen(
      (err) =>
        !(err instanceof CursorExpiredError) && !(err instanceof PayloadValidationError),
    ),
    {
      maxAttempts: 3,
      backoff: new ExponentialBackoff({
        initialDelay: 1_000,
        maxDelay: 30_000,
        exponent: 2,
      }),
    },
  );

  const breakerPolicy = circuitBreaker(handleAll, {
    halfOpenAfter: 30_000,
    breaker: new ConsecutiveBreaker(5),
  });

  const bulkheadPolicy = bulkhead(3, 10);

  return wrap(bulkheadPolicy, breakerPolicy, retryPolicy);
}

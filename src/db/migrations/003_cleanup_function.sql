-- cleanup_stale_runs: heal state left behind by a crashed/spun-down process.
-- Called at every service startup before accepting traffic.

CREATE OR REPLACE FUNCTION cleanup_stale_runs() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sync_runs
  SET status = 'failed',
      ended_at = NOW(),
      error_summary = '["Process killed mid-run (spin-down or crash); safe to retry"]'::jsonb
  WHERE status = 'running'
    AND started_at < NOW() - INTERVAL '30 minutes';

  UPDATE sync_state
  SET status = 'idle',
      lock_acquired_at = NULL
  WHERE status = 'running'
    AND lock_acquired_at < NOW() - INTERVAL '30 minutes';
END;
$$;

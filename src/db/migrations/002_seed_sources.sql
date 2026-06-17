-- Seed the source registry. Idempotent via ON CONFLICT.

INSERT INTO sources (id, display_name) VALUES
  ('hubspot',         'HubSpot CRM'),
  ('google-calendar', 'Google Calendar'),
  ('notion',          'Notion')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sync_state (source) VALUES
  ('hubspot'),
  ('google-calendar'),
  ('notion')
ON CONFLICT (source) DO NOTHING;

-- 014_o18_atomic_instrument_registration: allow the atomic onboarding event introduced by O18.
-- Existing migration 004 remains immutable. The event is projected transactionally into both
-- instruments and provider_instrument_mappings, so a failed mapping cannot leave an orphan instrument.

ALTER TABLE instrument_events
  DROP CONSTRAINT instrument_events_type_check;

ALTER TABLE instrument_events
  ADD CONSTRAINT instrument_events_type_check
  CHECK (type IN (
    'instrument_registered',
    'instrument_registered_with_mapping',
    'instrument_updated',
    'mapping_added',
    'mapping_closed',
    'symbol_changed'
  ));

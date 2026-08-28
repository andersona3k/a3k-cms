-- M1 — fatia vertical. Campos de pareamento no device.
-- hardware_id: identificador reportado pelo player (torna o re-pair idempotente).
-- token: segredo do device, usado nos endpoints de player (manifest/heartbeat).
-- last_version: ultima versao de playlist que o device confirmou ter aplicado.

ALTER TABLE devices ADD COLUMN hardware_id  TEXT;
ALTER TABLE devices ADD COLUMN token        TEXT;
ALTER TABLE devices ADD COLUMN last_version INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX idx_devices_hardware_id
  ON devices (hardware_id) WHERE hardware_id IS NOT NULL;
CREATE UNIQUE INDEX idx_devices_token
  ON devices (token) WHERE token IS NOT NULL;

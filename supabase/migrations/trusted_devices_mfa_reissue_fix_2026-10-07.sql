-- Allow re-issuing trust for the same device_id after revoke
ALTER TABLE public.trusted_devices DROP CONSTRAINT IF EXISTS trusted_devices_user_id_device_id_key;
DROP INDEX IF EXISTS trusted_devices_user_id_device_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS trusted_devices_user_device_active_uidx
  ON public.trusted_devices (user_id, device_id)
  WHERE revoked_at IS NULL;

-- Per-webhook signing secret.
-- Previously the webhook ID was used as the HMAC key, but the ID is public
-- (returned at registration, present in management URLs), so signatures
-- could be forged by anyone who knew it.
ALTER TABLE webhooks ADD COLUMN secret TEXT;

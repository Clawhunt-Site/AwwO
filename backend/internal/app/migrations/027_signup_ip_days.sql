-- Accounts created by first ClawHunt sign-ins per client address and UTC day (clawhunt_signup.go,
-- AWWO_NEW_ACCOUNTS_PER_IP_PER_DAY). ip_hash is a keyed hash (HMAC-SHA-256) of the day and the address, an
-- IPv6 address by its /64; no address is stored. Sign-in start deletes the days older than a few days. A new
-- table only, with no foreign keys; the short lock timeout matches the other additive migrations.
SET LOCAL lock_timeout = '10s';
CREATE TABLE IF NOT EXISTS signup_ip_days (
  day date NOT NULL,
  ip_hash text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  accounts integer NOT NULL CHECK (accounts >= 1),
  PRIMARY KEY (day, ip_hash)
);

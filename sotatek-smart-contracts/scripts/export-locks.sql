-- export-locks.sql — produce the per-address lock seed for the vFYUSD → sFYUSD
-- migration (scripts/migrate-vfyusd-to-sfyusd.js LOCKS_FILE).
--
-- Per active-position wallet, the on-chain lock is the LONGEST active lock:
--   unlock = MAX(position.created_at) + max(60, tenure) days
-- where tenure = the wallet's latest non-cancelled VAULT stake application's
-- lockup_period_days (default 60, matching the backend MIN_LOCK_DAYS floor).
-- Run against the gateway's Postgres; convert the rows to locks.json:
--   { "0xWALLET": <unlock_unix_seconds>, ... }
--
--   psql "$DB_URL" -t -A -F$'\t' -f scripts/export-locks.sql \
--     | awk -F'\t' 'BEGIN{print "{"} {printf "%s\"%s\": %s", (NR>1?",\n":""), $1, $2} END{print "\n}"}' \
--     > migration/locks.json
-- and holders.json (the addresses):
--   ... | awk -F'\t' 'BEGIN{print "["} {printf "%s\"%s\"", (NR>1?",\n":""), $1} END{print "\n]"}' > migration/holders.json

SELECT lower(ep.wallet_address) AS wallet,
       EXTRACT(EPOCH FROM (
         MAX(ep.created_at)
         + (GREATEST(60, COALESCE(sa.lockup_period_days, 60)) || ' days')::interval
       ))::bigint AS unlock_at
FROM earn_positions ep
LEFT JOIN LATERAL (
    SELECT lockup_period_days
    FROM stake_applications
    WHERE lower(wallet_address) = lower(ep.wallet_address)
      AND product = 'VAULT'
      AND status <> 'CANCELLED'
    ORDER BY created_at DESC
    LIMIT 1
) sa ON true
WHERE ep.status NOT IN ('CLOSED', 'FAILED')
GROUP BY lower(ep.wallet_address), sa.lockup_period_days;

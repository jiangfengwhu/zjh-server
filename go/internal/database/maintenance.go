package database

import (
	"context"
	"time"
)

// Expiry bookkeeping only; never deletes user content. Bounded batches avoid
// holding locks or monopolizing the small server during traffic bursts.
func (s *Store) Maintenance(ctx context.Context) {
	tick := time.NewTicker(15 * time.Minute)
	defer tick.Stop()
	for {
		work, cancel := context.WithTimeout(ctx, 10*time.Second)
		for _, q := range []string{
			"DELETE FROM account_sessions WHERE token_hash IN(SELECT token_hash FROM account_sessions WHERE expires_at<=$1 LIMIT 500)",
			"DELETE FROM login_challenges WHERE email_hash IN(SELECT email_hash FROM login_challenges WHERE expires_at<=$1 LIMIT 500)",
			"DELETE FROM rate_limits WHERE key IN(SELECT key FROM rate_limits WHERE expires_at<=$1 LIMIT 500)",
		} {
			if _, err := s.Pool.Exec(work, q, time.Now().UnixMilli()); err != nil {
				break
			}
		}
		_, _ = s.Pool.Exec(work, "DELETE FROM idempotency_requests WHERE ctid IN(SELECT ctid FROM idempotency_requests WHERE expires_at<=now() LIMIT 500)")
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

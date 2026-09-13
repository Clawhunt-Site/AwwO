package app

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
)

// One immutable snapshot contains BOTH windows. Scrapes never touch PostgreSQL
// and cannot observe a mixture of the old and new aggregation batches.
type usageWindowSnapshot struct {
	At   time.Time
	Rows []usageWindowRow
}
type usageWindowRow struct {
	Window, Runtime, Model, Outcome string
	Count                           float64
	Tokens                          [5]*float64
	Cost                            *float64
}
type usageWindowCollector struct {
	snapshot                                  atomic.Pointer[usageWindowSnapshot]
	invocations, tokens, cost, timestamp, age *prometheus.Desc
}

func newUsageWindowCollector() *usageWindowCollector {
	return &usageWindowCollector{
		invocations: prometheus.NewDesc("awwo_usage_window_invocations", "Committed ledger invocations in a fixed rolling window.", []string{"window", "runtime", "model", "outcome"}, nil),
		tokens:      prometheus.NewDesc("awwo_usage_window_tokens", "Known committed tokens; cache/reasoning are subsets, never sum directions.", []string{"window", "runtime", "model", "direction"}, nil),
		cost:        prometheus.NewDesc("awwo_usage_window_estimated_cost_usd", "Known ledger estimates, not total cost or provider invoices.", []string{"window", "runtime", "model"}, nil),
		timestamp:   prometheus.NewDesc("awwo_usage_snapshot_timestamp_seconds", "Last completely committed usage snapshot cutoff.", []string{"window"}, nil),
		age:         prometheus.NewDesc("awwo_usage_snapshot_age_seconds", "Seconds since successful snapshot; stale values are not current zero usage.", []string{"window"}, nil)}
}
func (c *usageWindowCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{c.invocations, c.tokens, c.cost, c.timestamp, c.age} {
		ch <- d
	}
}
func (c *usageWindowCollector) Collect(ch chan<- prometheus.Metric) {
	s := c.snapshot.Load()
	if s == nil {
		return
	}
	for _, w := range []string{"24h", "30d"} {
		ch <- prometheus.MustNewConstMetric(c.timestamp, prometheus.GaugeValue, float64(s.At.Unix()), w)
		ch <- prometheus.MustNewConstMetric(c.age, prometheus.GaugeValue, time.Since(s.At).Seconds(), w)
	}
	type totals struct {
		tokens [5]*float64
		cost   *float64
	}
	groups := map[[3]string]*totals{}
	for _, r := range s.Rows {
		ch <- prometheus.MustNewConstMetric(c.invocations, prometheus.GaugeValue, r.Count, r.Window, r.Runtime, r.Model, r.Outcome)
		key := [3]string{r.Window, r.Runtime, r.Model}
		g := groups[key]
		if g == nil {
			g = &totals{}
			groups[key] = g
		}
		for i, n := range r.Tokens {
			if n != nil {
				if g.tokens[i] == nil {
					x := 0.0
					g.tokens[i] = &x
				}
				*g.tokens[i] += *n
			}
		}
		if r.Cost != nil {
			if g.cost == nil {
				x := 0.0
				g.cost = &x
			}
			*g.cost += *r.Cost
		}
	}
	dirs := []string{"input", "output", "cache_read", "cache_write", "reasoning"}
	for key, g := range groups {
		for i, n := range g.tokens {
			if n != nil {
				ch <- prometheus.MustNewConstMetric(c.tokens, prometheus.GaugeValue, *n, key[0], key[1], key[2], dirs[i])
			}
		}
		if g.cost != nil {
			ch <- prometheus.MustNewConstMetric(c.cost, prometheus.GaugeValue, *g.cost/1e6, key[0], key[1], key[2])
		}
	}
}
func (a *App) startUsageAggregation(ctx context.Context) {
	collector := newUsageWindowCollector()
	a.obs.registry.MustRegister(collector)
	counter := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "awwo_usage_aggregation_runs_total", Help: "Bounded complete ledger snapshot attempts."}, []string{"outcome"})
	a.obs.registry.MustRegister(counter)
	a.obs.tasks.Add(1)
	go func() {
		defer a.obs.tasks.Done()
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			snapshot, err := a.readUsageWindowSnapshot(ctx)
			if err == nil {
				collector.snapshot.Store(snapshot)
				counter.WithLabelValues("success").Inc()
			} else if ctx.Err() == nil {
				outcome := "error"
				if errors.Is(err, context.DeadlineExceeded) {
					outcome = "timeout"
				}
				if errors.Is(err, errUsageSnapshotLimit) {
					outcome = "row_limit"
				}
				counter.WithLabelValues(outcome).Inc()
			}
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
	}()
}

var errUsageSnapshotLimit = errors.New("usage snapshot row limit")

func (a *App) readUsageWindowSnapshot(parent context.Context) (*usageWindowSnapshot, error) {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SET LOCAL statement_timeout='2500ms'"); err != nil {
		return nil, err
	}
	snapshot := &usageWindowSnapshot{At: time.Now().UTC()}
	// GROUP BY happens in SQL under a statement deadline. The result and the
	// in-memory representation have an independent hard cap.
	for _, window := range []struct {
		name string
		span time.Duration
	}{{"24h", 24 * time.Hour}, {"30d", 30 * 24 * time.Hour}} {
		rows, e := tx.Query(ctx, `SELECT runtime,model_id,status,count(*)::float8,
 sum(input_tokens) FILTER(WHERE usage_status IN ('reported','partial'))::float8,sum(output_tokens) FILTER(WHERE usage_status IN ('reported','partial'))::float8,
 sum(cached_input_tokens) FILTER(WHERE usage_status IN ('reported','partial'))::float8,sum(cache_write_tokens) FILTER(WHERE usage_status IN ('reported','partial'))::float8,
 sum(reasoning_tokens) FILTER(WHERE usage_status IN ('reported','partial'))::float8,sum(estimated_cost_microusd) FILTER(WHERE cost_status IN ('estimated','reconciled'))::float8
 FROM model_invocations WHERE status<>'running' AND completed_at>=$1 AND completed_at<$2 GROUP BY runtime,model_id,status LIMIT 2049`, snapshot.At.Add(-window.span), snapshot.At)
		if e != nil {
			return nil, e
		}
		count := 0
		// Collapsing unknown historical catalog selectors prevents cardinality growth
		// while retaining their aggregate counts under the bounded unknown selector.
		grouped := map[[3]string]*usageWindowRow{}
		for rows.Next() {
			var r usageWindowRow
			r.Window = window.name
			if e = rows.Scan(&r.Runtime, &r.Model, &r.Outcome, &r.Count, &r.Tokens[0], &r.Tokens[1], &r.Tokens[2], &r.Tokens[3], &r.Tokens[4], &r.Cost); e != nil {
				rows.Close()
				return nil, e
			}
			count++
			if count > 2048 {
				rows.Close()
				return nil, errUsageSnapshotLimit
			}
			r.Model = a.telemetryModel(r.Runtime, r.Model)
			key := [3]string{r.Runtime, r.Model, r.Outcome}
			if prior := grouped[key]; prior != nil {
				prior.Count += r.Count
				for i, n := range r.Tokens {
					if n != nil {
						if prior.Tokens[i] == nil {
							x := 0.0
							prior.Tokens[i] = &x
						}
						*prior.Tokens[i] += *n
					}
				}
				if r.Cost != nil {
					if prior.Cost == nil {
						x := 0.0
						prior.Cost = &x
					}
					*prior.Cost += *r.Cost
				}
			} else {
				copy := r
				grouped[key] = &copy
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		for _, r := range grouped {
			snapshot.Rows = append(snapshot.Rows, *r)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return snapshot, nil
}

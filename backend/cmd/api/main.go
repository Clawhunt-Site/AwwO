package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"awwo/backend/internal/app"
)

func main() {
	if e := run(); e != nil {
		slog.Error("Awwo API stopped", "error", e)
		os.Exit(1)
	}
}
func run() error {
	cfg, e := app.ConfigFromEnv()
	if e != nil {
		return e
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, e := app.OpenDatabase(ctx, cfg.DatabaseURL)
	if e != nil {
		return errors.New("cannot connect to AWWO_DATABASE_URL")
	}
	defer db.Close()
	if e = app.Migrate(ctx, db); e != nil {
		return e
	}
	a := app.New(db, cfg)
	defer a.Close()
	if e = a.Start(ctx); e != nil {
		return e
	}
	if e = a.StartObservability(ctx); e != nil {
		return e
	}
	if e = a.BootstrapAdmin(ctx); e != nil {
		return e
	}
	srv := &http.Server{Addr: cfg.ListenAddr, Handler: a.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stopped)
	errs := make(chan error, 1)
	go func() {
		slog.Info("Awwo API listening", "address", cfg.ListenAddr, "environment", cfg.Env)
		errs <- srv.ListenAndServe()
	}()
	select {
	case <-stopped:
		shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		a.Close()
		return srv.Shutdown(shutdown)
	case e = <-errs:
		if errors.Is(e, http.ErrServerClosed) {
			return nil
		}
		return e
	}
}

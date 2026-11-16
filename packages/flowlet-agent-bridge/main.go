// Flowlet's private loopback adapter. Protocol conversion is implemented by the
// upstream Apache-2.0 a2a-go a2aacp executor, pinned in go.mod.
package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2aext/structuredinput"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
	"github.com/a2aproject/a2a-go/v2/a2asrv/taskstore"
	"github.com/a2aproject/a2a-go/v2/integrations/executor/a2aacp"
)

type config struct {
	Name           string   `json:"name"`
	Command        string   `json:"command"`
	Args           []string `json:"args"`
	Cwd            string   `json:"cwd"`
	Token          string   `json:"token"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
}

// Bound retained SDK task/session state. Reject before executing more work; no
// silent eviction of live tasks. A runtime restart starts a fresh task space.
type boundedStore struct {
	taskstore.Store
	mu    sync.Mutex
	count int
}

func (s *boundedStore) Create(ctx context.Context, task *a2a.Task) (taskstore.TaskVersion, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.count >= 1000 {
		return taskstore.TaskVersionMissing, errors.New("ACP runtime task limit reached; restart the runtime")
	}
	version, err := s.Store.Create(ctx, task)
	if err == nil {
		s.count++
	}
	return version, err
}

func run() error {
	input := bufio.NewReader(io.LimitReader(os.Stdin, 128*1024))
	line, err := input.ReadBytes('\n')
	if err != nil {
		return fmt.Errorf("read runtime configuration: %w", err)
	}
	var cfg config
	if err := json.Unmarshal(line, &cfg); err != nil {
		return err
	}
	if cfg.Command == "" || cfg.Cwd == "" || len(cfg.Token) < 32 || cfg.TimeoutSeconds < 5 || cfg.TimeoutSeconds > 1800 {
		return errors.New("invalid runtime configuration")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// A closed parent pipe is authoritative, including an ungraceful Node Host exit.
	go func() { _, _ = io.Copy(io.Discard, input); stop() }()
	executor, err := a2aacp.NewExecutor(ctx, a2aacp.Process{Argv: append([]string{cfg.Command}, cfg.Args...), Dir: cfg.Cwd}, &a2aacp.Config{
		StartTimeout: 10 * time.Second, CancelTimeout: 5 * time.Second,
		InactivityTimeout: time.Duration(cfg.TimeoutSeconds) * time.Second,
		QuestionTimeout:   time.Duration(cfg.TimeoutSeconds) * time.Second,
		RejectBusyContext: true,
	})
	if err != nil {
		return fmt.Errorf("initialize ACP agent: %w", err)
	}
	defer executor.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	endpoint := "http://" + listener.Addr().String()
	card := &a2a.AgentCard{
		Name: cfg.Name, Description: "ACP agent managed by Flowlet; tasks and sessions last until the runtime stops.", Version: "0.2.0",
		SupportedInterfaces: []*a2a.AgentInterface{a2a.NewAgentInterface(endpoint, a2a.TransportProtocolJSONRPC)},
		Capabilities:        a2a.AgentCapabilities{Streaming: true, Extensions: []a2a.AgentExtension{structuredinput.NewExtension(structuredinput.DefaultDraft)}},
		DefaultInputModes:   []string{"text/plain", "application/json"}, DefaultOutputModes: []string{"text/plain", "application/json"},
		Skills: []a2a.AgentSkill{},
	}
	enforcer, err := a2asrv.NewAgentCardEnforcer(card)
	if err != nil {
		return err
	}
	store := &boundedStore{Store: taskstore.NewInMemory(nil)}
	rpc := a2asrv.NewJSONRPCHandler(a2asrv.NewHandler(executor, a2asrv.WithTaskStore(store), a2asrv.WithCallInterceptors(enforcer)))
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+cfg.Token)) != 1 {
			http.Error(w, "Unauthorized", 401)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/.well-known/agent-card.json" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(card)
			return
		}
		if r.Method != "POST" || r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4*1024*1024)
		rpc.ServeHTTP(w, r)
	})}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"endpoint": endpoint + "/", "card": card}); err != nil {
		_ = server.Close()
		return err
	}
	select {
	case <-ctx.Done():
		_ = server.Close()
		return nil
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

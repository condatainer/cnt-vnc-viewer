package audio

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/condatainer/cnt-vnc-viewer/pkg/config"
)

// Spawner manages the lifecycle of an isolated, headless virtual PulseAudio daemon.
// Designed specifically for headless HPC compute nodes without physical audio hardware.
type Spawner struct {
	Dir        string
	SocketPath string
	ConfigFile string
	cmd        *exec.Cmd
	started    bool
}

// NewSpawner creates a spawner targeting an isolated UNIX socket.
func NewSpawner(vncAddr, pulseServer string) *Spawner {
	var socketPath string
	var pulseDir string

	if strings.HasPrefix(pulseServer, "unix:") && !strings.Contains(pulseServer, "/mnt/wslg") {
		socketPath = strings.TrimPrefix(pulseServer, "unix:")
		pulseDir = filepath.Dir(socketPath)
	} else {
		displayNum := config.ParseDisplayFromVNCAddr(vncAddr)
		uid := os.Getuid()
		pulseDir = fmt.Sprintf("/tmp/pulse-vnc-%d-%d", displayNum, uid)
		socketPath = filepath.Join(pulseDir, "native")
	}

	configFile := filepath.Join(pulseDir, "headless.pa")

	return &Spawner{
		Dir:        pulseDir,
		SocketPath: socketPath,
		ConfigFile: configFile,
	}
}

// Start launches pulseaudio in headless virtual null-sink mode with real-time output logging.
func (s *Spawner) Start() (string, error) {
	pulseBin, err := exec.LookPath("pulseaudio")
	if err != nil {
		return "", fmt.Errorf("pulseaudio binary not found in PATH: %w", err)
	}

	if err := os.MkdirAll(s.Dir, 0700); err != nil {
		return "", fmt.Errorf("failed to create pulse runtime directory %s: %w", s.Dir, err)
	}

	// Clean any previous socket or stale pid
	pidFile := filepath.Join(s.Dir, "pid")
	if data, err := os.ReadFile(pidFile); err == nil {
		if stalePid, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && stalePid > 0 {
			if proc, err := os.FindProcess(stalePid); err == nil {
				_ = proc.Signal(syscall.SIGKILL)
			}
		}
	}
	_ = os.Remove(s.SocketPath)
	_ = os.Remove(pidFile)

	// Write headless minimal PA script (bypasses default.pa to avoid non-existent ALSA/udev hardware)
	paContent := fmt.Sprintf(`load-module module-native-protocol-unix socket=%s auth-anonymous=1
load-module module-null-sink sink_name=Virtual_Speaker sink_properties=device.description=Virtual_Speaker rate=48000 channels=2
load-module module-always-sink
set-default-sink Virtual_Speaker
`, s.SocketPath)

	if err := os.WriteFile(s.ConfigFile, []byte(paContent), 0600); err != nil {
		return "", fmt.Errorf("failed to write pulse config %s: %w", s.ConfigFile, err)
	}

	// Write client.conf so client applications in this session disable autospawn
	clientConf := fmt.Sprintf("default-server = unix:%s\nautospawn = no\n", s.SocketPath)
	_ = os.WriteFile(filepath.Join(s.Dir, "client.conf"), []byte(clientConf), 0600)

	args := []string{
		"-n",
		"-F", s.ConfigFile,
		"--daemonize=no",
		"--exit-idle-time=-1",
		"--disallow-exit=true",
		"--realtime=false",
	}

	log.Printf("[audio] Starting headless virtual PulseAudio daemon (%s)...", s.SocketPath)
	cmd := exec.Command(pulseBin, args...)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("PULSE_RUNTIME_PATH=%s", s.Dir),
		fmt.Sprintf("PULSE_STATE_PATH=%s", s.Dir),
	)

	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return "", fmt.Errorf("failed to open stderr pipe: %w", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("failed to open stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("failed to start pulseaudio: %w", err)
	}
	s.cmd = cmd

	go pipeLogger("[pulse]", stderrPipe)
	go pipeLogger("[pulse]", stdoutPipe)

	// Wait up to 3 seconds for socket to appear
	ready := false
	for i := 0; i < 30; i++ {
		if fi, err := os.Stat(s.SocketPath); err == nil && (fi.Mode()&os.ModeSocket != 0 || fi.Mode().IsRegular()) {
			ready = true
			break
		}
		// Check if process died early
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			return "", fmt.Errorf("pulseaudio exited prematurely with code %d", cmd.ProcessState.ExitCode())
		}
		time.Sleep(100 * time.Millisecond)
	}

	if !ready {
		s.Stop()
		return "", fmt.Errorf("pulseaudio socket %s did not initialize within 3s", s.SocketPath)
	}

	s.started = true
	serverAddr := "unix:" + s.SocketPath
	_ = os.Setenv("PULSE_SERVER", serverAddr)
	log.Printf("[audio] Headless virtual PulseAudio daemon active at %s (sink: Virtual_Speaker, PID: %d)", serverAddr, cmd.Process.Pid)
	return serverAddr, nil
}

// Stop terminates the spawned PulseAudio daemon and cleans up the runtime directory.
func (s *Spawner) Stop() {
	if !s.started || s.cmd == nil || s.cmd.Process == nil {
		return
	}
	s.started = false
	pid := s.cmd.Process.Pid
	log.Printf("[audio] Stopping headless virtual PulseAudio daemon (PID %d)...", pid)

	// Graceful shutdown via SIGTERM
	_ = s.cmd.Process.Signal(syscall.SIGTERM)

	done := make(chan struct{})
	go func() {
		_ = s.cmd.Wait()
		close(done)
	}()

	select {
	case <-done:
		log.Printf("[audio] PulseAudio daemon (PID %d) cleanly stopped", pid)
	case <-time.After(1500 * time.Millisecond):
		log.Printf("[audio] Force killing PulseAudio daemon (PID %d)...", pid)
		_ = s.cmd.Process.Kill()
		<-done
	}

	_ = os.RemoveAll(s.Dir)
}

func pipeLogger(prefix string, r io.Reader) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		text := strings.TrimSpace(scanner.Text())
		if text != "" {
			log.Printf("%s %s", prefix, text)
		}
	}
}

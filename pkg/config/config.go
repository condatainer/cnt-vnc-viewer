package config

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/condatainer/cnt-vnc-viewer/pkg/version"
)

// Config represents the runtime configuration for the web VNC client server.
type Config struct {
	// Web Server Networking
	ListenHTTP  string // Default: 127.0.0.1:8080 (Prioritizing localhost HTTP for SSH forwarding)
	ListenHTTPS string // Optional: e.g. ":8443" for external HTTPS
	TLSCert     string // Path to TLS certificate PEM
	TLSKey      string // Path to TLS private key PEM
	AutoTLS     bool   // Automatically generate ephemeral self-signed ECDSA certificate

	// VNC Target (TurboVNC, TigerVNC, etc.)
	VNCAddr string // TCP address "host:port" or "unix:/path/to/socket"

	// NativeGeometry is the resolution the remote desktop was launched at (e.g. "1920x1080"),
	// as passed to `vncserver -geometry`. Reported via /api/session so the frontend can
	// restore this exact resolution when leaving remote-resize mode, even across a page
	// reload - the client can't reliably infer this on its own since the live ServerInit
	// report just reflects whatever the desktop's current (possibly already RandR-resized)
	// size happens to be, not what it was originally launched at.
	NativeGeometry string

	// PulseAudio Target
	PulseServer string // "unix:/path" or "tcp:host:port" (autodetected if empty)
	PulseCookie string // Path to PulseAudio authentication cookie (autodetected if empty)
	EnableAudio bool   // Master audio toggle
	PulseSpawn  bool   // Spawn an isolated headless virtual PulseAudio daemon with null-sink

	// AudioSampleRate/AudioChannels are the initial speaker capture format (Hz / channel count).
	// Session-wide, not per-client: all browser tabs attached to this process share one
	// PulseAudio record stream, so this is just the starting point - the frontend Settings
	// panel can change it at runtime (see audio.Manager.SetQuality), which re-broadcasts to
	// every connected client.
	AudioSampleRate int
	AudioChannels   int

	// Security & Access
	AuthToken string // Optional shared secret token for web client authentication
	WebDir    string // Optional directory for static files (if empty, uses embedded files)

	// Logging
	LogFile  string // Path to write log file (if empty, logs write to stdout)
	LogLevel string // Logging verbosity: "debug", "info", "warn", "error" (default: "info")
	Debug    bool   // Enable debug mode (sets log-level to debug)
}

// Load loads configuration from CLI flags and environment variables.
// CLI flags override environment variables; environment variables override defaults.
func Load() (*Config, error) {
	cfg := &Config{}

	// Defaults / Environment variables
	defaultHTTP := getEnv("LISTEN_HTTP", "127.0.0.1:8080")
	defaultHTTPS := getEnv("LISTEN_HTTPS", "")
	defaultTLSCert := getEnv("TLS_CERT", "")
	defaultTLSKey := getEnv("TLS_KEY", "")
	defaultAutoTLS := getEnvBool("AUTO_TLS", false)

	defaultVNC := getEnv("VNC_ADDR", "127.0.0.1:5901")
	defaultNativeGeometry := getEnv("NATIVE_GEOMETRY", "")
	defaultPulse := getEnv("PULSE_SERVER", "")
	defaultPulseCookie := getEnv("PULSE_COOKIE", "")
	defaultAudio := getEnvBool("ENABLE_AUDIO", true)
	defaultPulseSpawn := getEnvBool("PULSE_SPAWN", false)
	defaultAudioSampleRate := getEnvInt("AUDIO_SAMPLE_RATE", 24000)
	defaultAudioChannels := getEnvInt("AUDIO_CHANNELS", 1)

	defaultAuthToken := getEnv("AUTH_TOKEN", "")
	defaultWebDir := getEnv("WEB_DIR", "")

	defaultLogFile := getEnv("LOG_FILE", "")
	defaultLogLevel := getEnv("LOG_LEVEL", "info")
	defaultDebug := getEnvBool("DEBUG", false)

	// Define flags
	flag.StringVar(&cfg.ListenHTTP, "listen-http", defaultHTTP, "Address to listen on for HTTP (prioritize localhost for SSH tunnels, e.g. 127.0.0.1:8080)")
	flag.StringVar(&cfg.ListenHTTPS, "listen-https", defaultHTTPS, "Optional address to listen on for HTTPS (e.g. :8443)")
	flag.StringVar(&cfg.TLSCert, "tls-cert", defaultTLSCert, "Path to TLS certificate file")
	flag.StringVar(&cfg.TLSKey, "tls-key", defaultTLSKey, "Path to TLS private key file")
	flag.BoolVar(&cfg.AutoTLS, "auto-tls", defaultAutoTLS, "Generate an ephemeral self-signed certificate if TLS cert is not provided")

	flag.StringVar(&cfg.VNCAddr, "vnc-addr", defaultVNC, "Target VNC server address (TCP 'host:port' or 'unix:/path')")
	flag.StringVar(&cfg.NativeGeometry, "native-geometry", defaultNativeGeometry, "Resolution the remote desktop was launched at, e.g. '1920x1080' (reported via /api/session for restoring after remote-resize)")
	flag.StringVar(&cfg.PulseServer, "pulse-server", defaultPulse, "PulseAudio server address ('unix:/path' or 'tcp:host:port', autodetects if empty)")
	flag.StringVar(&cfg.PulseCookie, "pulse-cookie", defaultPulseCookie, "Path to PulseAudio authentication cookie (autodetects if empty)")
	flag.BoolVar(&cfg.EnableAudio, "enable-audio", defaultAudio, "Enable PulseAudio bidirectional streaming bridge")
	flag.BoolVar(&cfg.PulseSpawn, "pulse-spawn", defaultPulseSpawn, "Spawn and manage an isolated headless virtual PulseAudio daemon with null-sink")
	flag.IntVar(&cfg.AudioSampleRate, "audio-sample-rate", defaultAudioSampleRate, "Initial speaker capture sample rate in Hz (client can change this at runtime)")
	flag.IntVar(&cfg.AudioChannels, "audio-channels", defaultAudioChannels, "Initial speaker capture channel count, 1 (mono) or 2 (stereo)")

	flag.StringVar(&cfg.AuthToken, "auth-token", defaultAuthToken, "Optional authentication token required to access the client")
	flag.StringVar(&cfg.WebDir, "web-dir", defaultWebDir, "Optional local directory containing static frontend files (for dev mode)")

	flag.StringVar(&cfg.LogFile, "log-file", defaultLogFile, "Path to write server log file (when given, logs go to this file; otherwise stdout)")
	flag.StringVar(&cfg.LogLevel, "log-level", defaultLogLevel, "Logging verbosity level (debug, info, warn, error)")
	flag.BoolVar(&cfg.Debug, "debug", defaultDebug, "Enable debug mode (sets log-level to debug)")

	var showVersion bool
	flag.BoolVar(&showVersion, "version", false, "Print version and exit")
	flag.BoolVar(&showVersion, "v", false, "Print version and exit (shorthand)")

	flag.Parse()

	if showVersion {
		fmt.Println(version.Version)
		os.Exit(0)
	}

	// Normalize debug and log-level
	if cfg.Debug {
		cfg.LogLevel = "debug"
	} else if cfg.LogLevel == "debug" || cfg.LogLevel == "DEBUG" {
		cfg.Debug = true
	}

	pulseServerFlagPassed := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "pulse-server" {
			pulseServerFlagPassed = true
		}
	})

	// Autodetect or assign PulseAudio server socket
	if cfg.EnableAudio {
		if cfg.PulseSpawn && !pulseServerFlagPassed {
			displayNum := ParseDisplayFromVNCAddr(cfg.VNCAddr)
			uid := os.Getuid()
			cfg.PulseServer = fmt.Sprintf("unix:/tmp/pulse-vnc-%d-%d/native", displayNum, uid)
		} else if cfg.PulseServer == "" {
			cfg.PulseServer = AutodetectPulseServer()
		}
	}

	// Autodetect PulseAudio cookie if not specified and not spawning an anonymous daemon
	if cfg.EnableAudio && cfg.PulseCookie == "" && !cfg.PulseSpawn {
		cfg.PulseCookie = AutodetectPulseCookie()
	}

	return cfg, nil
}

// AutodetectPulseServer searches standard paths for the PulseAudio socket.
func AutodetectPulseServer() string {
	// 1. Check $PULSE_SERVER
	if s := os.Getenv("PULSE_SERVER"); s != "" {
		return s
	}

	// 2. Check dedicated VNC pulse sockets /tmp/pulse-vnc-*/native
	vncMatches, _ := filepath.Glob("/tmp/pulse-vnc-*/native")
	for _, m := range vncMatches {
		if info, err := os.Stat(m); err == nil && !info.IsDir() {
			return "unix:" + m
		}
	}

	// 3. Check $XDG_RUNTIME_DIR/pulse/native
	if runtimeDir := os.Getenv("XDG_RUNTIME_DIR"); runtimeDir != "" {
		p := filepath.Join(runtimeDir, "pulse", "native")
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return "unix:" + p
		}
	}

	// 4. Check /run/user/<UID>/pulse/native
	uid := os.Getuid()
	runUserPulse := fmt.Sprintf("/run/user/%d/pulse/native", uid)
	if info, err := os.Stat(runUserPulse); err == nil && !info.IsDir() {
		return "unix:" + runUserPulse
	}

	// 5. Check /tmp/pulse-*/native
	matches, _ := filepath.Glob("/tmp/pulse-*/native")
	for _, m := range matches {
		if info, err := os.Stat(m); err == nil && !info.IsDir() {
			return "unix:" + m
		}
	}

	// 6. Default fallback to local TCP
	return "tcp:127.0.0.1:4713"
}

// AutodetectPulseCookie searches standard locations for the PulseAudio cookie.
func AutodetectPulseCookie() string {
	if c := os.Getenv("PULSE_COOKIE"); c != "" {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}

	home, err := os.UserHomeDir()
	if err == nil {
		// 1. ~/.config/pulse/cookie
		configCookie := filepath.Join(home, ".config", "pulse", "cookie")
		if _, err := os.Stat(configCookie); err == nil {
			return configCookie
		}

		// 2. ~/.pulse-cookie
		legacyCookie := filepath.Join(home, ".pulse-cookie")
		if _, err := os.Stat(legacyCookie); err == nil {
			return legacyCookie
		}
	}

	return ""
}

// ParseDisplayFromVNCAddr parses the display number from a VNC address like ":1", "127.0.0.1:5901", etc.
func ParseDisplayFromVNCAddr(addr string) int {
	parts := strings.Split(addr, ":")
	if len(parts) == 0 {
		return 10
	}
	last := parts[len(parts)-1]
	val, err := strconv.Atoi(last)
	if err != nil {
		return 10
	}
	if val >= 5900 {
		return val - 5900
	}
	return val
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func getEnvBool(key string, defaultVal bool) bool {
	if val := os.Getenv(key); val != "" {
		if b, err := strconv.ParseBool(val); err == nil {
			return b
		}
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			return n
		}
	}
	return defaultVal
}

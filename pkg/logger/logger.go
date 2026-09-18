package logger

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

// Level represents the severity level of a log message.
type Level int32

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

var (
	currentLevel atomic.Int32
	writerMu     sync.RWMutex
	activeWriter io.Writer = os.Stdout
)

func init() {
	currentLevel.Store(int32(LevelInfo))
}

// ParseLevel parses a log level string into a Level.
func ParseLevel(lvl string) Level {
	switch strings.ToLower(strings.TrimSpace(lvl)) {
	case "debug":
		return LevelDebug
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

// String returns the uppercase string representation of the Level.
func (l Level) String() string {
	switch l {
	case LevelDebug:
		return "DEBUG"
	case LevelWarn:
		return "WARN"
	case LevelError:
		return "ERROR"
	default:
		return "INFO"
	}
}

// SetLevel updates the active logging level.
func SetLevel(lvl Level) {
	currentLevel.Store(int32(lvl))
}

// GetLevel returns the current logging level.
func GetLevel() Level {
	return Level(currentLevel.Load())
}

// IsDebug returns true if debug logging is enabled.
func IsDebug() bool {
	return GetLevel() <= LevelDebug
}

// Setup initializes the logging subsystem based on file path, log level, and debug flag.
// - Destination is strictly determined by logFile:
//     - If logFile != "": output goes to the file.
//     - If logFile == "": output goes to os.Stdout console.
// - Verbosity is determined by debug / levelStr:
//     - If debug is true: log level is LevelDebug.
//     - Otherwise: log level is parsed from levelStr (default LevelInfo).
func Setup(logFile string, levelStr string, debug bool) (func(), io.Writer) {
	lvl := ParseLevel(levelStr)
	if debug {
		lvl = LevelDebug
	}
	SetLevel(lvl)

	var out io.Writer
	var closeFn func()

	if logFile != "" {
		dir := filepath.Dir(logFile)
		if err := os.MkdirAll(dir, 0755); err != nil && !os.IsExist(err) {
			log.Printf("[logger] Warning: failed to create log directory: %v", err)
		}
		f, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			log.Fatalf("[logger] Failed to open log file %s: %v", logFile, err)
		}
		out = f
		closeFn = func() { _ = f.Close() }
	} else {
		out = os.Stdout
	}

	writerMu.Lock()
	activeWriter = out
	writerMu.Unlock()

	log.SetOutput(out)
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds | log.Lshortfile)

	return closeFn, out
}

// Debugf logs a formatted message at DEBUG level if debug logging is enabled.
func Debugf(format string, args ...any) {
	if GetLevel() <= LevelDebug {
		log.Output(2, fmt.Sprintf("[DEBUG] "+format, args...))
	}
}

// Infof logs a formatted message at INFO level.
func Infof(format string, args ...any) {
	if GetLevel() <= LevelInfo {
		log.Output(2, fmt.Sprintf("[INFO] "+format, args...))
	}
}

// Warnf logs a formatted message at WARN level.
func Warnf(format string, args ...any) {
	if GetLevel() <= LevelWarn {
		log.Output(2, fmt.Sprintf("[WARN] "+format, args...))
	}
}

// Errorf logs a formatted message at ERROR level.
func Errorf(format string, args ...any) {
	if GetLevel() <= LevelError {
		log.Output(2, fmt.Sprintf("[ERROR] "+format, args...))
	}
}

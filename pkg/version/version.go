// Package version holds the build-time version string.
package version

// Version is set at build time via:
//
//	go build -ldflags "-X github.com/condatainer/cnt-vnc-viewer/pkg/version.Version=v1.2.3"
//
// Left as "dev" for a plain `go build` with no ldflags.
var Version = "dev"

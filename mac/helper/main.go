// Spoilaint helper for macOS: the Mac counterpart of the Windows tray app (tray/*.cs).
//
//	spoilaint-helper serve      background agent (launchd): VLC's speech-sync and .mkv jobs, plus the app window
//	                            (a local page at http://127.0.0.1:<port>) with setup, progress, settings and the
//	                            add-to-browser guide
//	spoilaint-helper open       what Spoilaint.app runs: installs/updates from the app bundle, starts the agent,
//	                            opens the window
//	spoilaint-helper aligntest  bench: same output as tray/test/AlignTest.cs
package main

import (
	"fmt"
	"os"
	"strings"
)

const version = "0.8.0"

func main() {
	// Spoilaint.app runs this binary with no arguments (old macOS adds -psn_...): open the app.
	if len(os.Args) < 2 || strings.HasPrefix(os.Args[1], "-psn") {
		if err := openApp(nil); err != nil {
			fmt.Fprintln(os.Stderr, "spoilaint:", err)
			alert("Spoilaint couldn't start", err.Error())
			os.Exit(1)
		}
		return
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = serve()
	case "open":
		err = openApp(os.Args[2:])
	case "aligntest":
		err = alignTest(os.Args[2:])
	case "version":
		fmt.Println(version)
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "spoilaint:", err)
		os.Exit(1)
	}
}

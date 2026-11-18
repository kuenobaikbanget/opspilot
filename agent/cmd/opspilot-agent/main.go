package main

import (
	"fmt"
	"github.com/opspilot/opspilot/agent/internal/agent"
	"log"
	"os"
)

func main() {
	var err error
	switch {
	case len(os.Args) == 1:
		err = agent.Run()
	case len(os.Args) == 2 && os.Args[1] == "enroll":
		err = agent.EnrollOnly()
	default:
		fmt.Fprintln(os.Stderr, "Usage: opspilot-agent [enroll]")
		os.Exit(1)
	}
	if err != nil {
		log.Fatal(err)
	}
}

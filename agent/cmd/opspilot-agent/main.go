package main

import (
	"github.com/opspilot/opspilot/agent/internal/agent"
	"log"
)

func main() {
	if err := agent.Run(); err != nil {
		log.Fatal(err)
	}
}

package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/bafto/PeerToPeer/messages"
)

const (
	server_port  = 7777
	client_port  = 7778
	read_timeout = time.Second * 5
)

func main() {
	serverAddr, err := net.ResolveTCPAddr("tcp4", fmt.Sprintf("localhost:%d", server_port))
	if err != nil {
		panic(err)
	}

	serverConn, err := net.DialTCP("tcp", nil, serverAddr)
	if err != nil {
		panic(err)
	}

	handleConnection(serverConn)
}

func handleConnection(conn net.Conn) {
	stdinReader := bufio.NewReader(os.Stdin)
	fmt.Printf("Enter your nickname: ")
	name, _ := stdinReader.ReadString('\n')
	name = strings.Trim(name, "\r\n")

	fmt.Println("connecting to server...")
	if err := messages.WriteRegistrationRequest(conn, []byte{127, 0, 0, 1}, client_port, name); err != nil {
		fmt.Printf("Error connecting to server: %s\n", err)
		os.Exit(1)
	}

	regResp, err := messages.ReadRegistrationResponseMessage(conn)
	if err != nil {
		fmt.Printf("Error reading registration response from server: %s\n", err)
		os.Exit(1)
	}
	fmt.Printf("Successfully registered at server")
	time.Sleep(time.Second * 3)
	os.Exit(0)

	_ = regResp
}

func handleUserInput() {
}

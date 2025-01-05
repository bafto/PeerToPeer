package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
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

	fmt.Println("connected to server")
	handleConnection(serverConn)
}

var (
	client_list       = make(map[string]messages.ClientInfo, 8)
	client_list_mutex sync.Mutex
)

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

	client_list_mutex.Lock()

	for _, client := range regResp.Clients {
		client_list[client.Name] = client
	}

	client_list_mutex.Unlock()

	fmt.Println("Successfully registered at server")


	closeClientChan := make(chan os.Signal, 1)
	signal.Notify(closeClientChan, syscall.SIGINT, syscall.SIGTERM)

	// concurrent logging
	log := make(chan string)
	go func() {
		for msg := range log {
			fmt.Printf("< %s\n", msg)
		}
	}()

	wg := sync.WaitGroup{}

	wg.Add(2)
	go handleServer(conn, &wg, log)
	go handleUserInput(stdinReader, conn, &wg, log)

	go func() {
		wg.Wait()
		closeClientChan <- syscall.SIGTERM
	}()

	<-closeClientChan
	fmt.Println("closing client")
	disconnect(conn)
}

func handleServer(conn net.Conn, wg *sync.WaitGroup, log chan string) {
	for {
		msg_id := []byte{0}
		_, err := conn.Read(msg_id)
		if err != nil {
			log <- "connection to server lost"
			break
		}

		switch messages.MessageID(msg_id[0]) {
		case messages.Broadcast:
			msg := messages.ReadBroadcastMessage(conn)
			log <- "Broadcast: " + msg.Message
		case messages.ClientDisconnectedS2C:
			msg := messages.ReadClientDisconnectMessage(conn)
			log <- msg.Name + " disconnected"

			client_list_mutex.Lock()
			delete(client_list, msg.Name)
			client_list_mutex.Unlock()
		case messages.NewClientConnected:
			msg := messages.ReadNewClientConnectedMessage(conn)
			log <- msg.Client.Name + " connected"

			client_list_mutex.Lock()
			client_list[msg.Client.Name] = msg.Client
			client_list_mutex.Unlock()
		default:
			log <- "invalid msg id found"
		}
	}
	wg.Done()
}

const help = `You can now enter the following commands:
	help: display this help
	broadcast <message>: broadcast <message> to all other clients`

func handleUserInput(stdin *bufio.Reader, conn net.Conn, wg *sync.WaitGroup, log chan string) {
	log <- help
	for {
		line, err := stdin.ReadString('\n')
		if err == io.EOF {
			break
		}
		line = strings.Trim(line, "\r\n")
		if line == "" {
			continue
		}

		cmds := strings.Split(line, " ")
		switch cmds[0] {
		case "help":
			log <- help
		case "broadcast":
			if len(cmds) < 2 {
				log <- "You need to enter a message to broadcast!"
				break
			}

			messages.WriteBroadcastMessage(conn, strings.Join(cmds[1:], " "))
		default:
			log <- "unknown command '" + cmds[0] + "'"
		}
	}
	wg.Done()
}

func disconnect(conn net.Conn) {
	conn.Write([]byte{byte(messages.DisconnectC2S)})
}

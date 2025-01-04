package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"sync"

	"github.com/bafto/PeerToPeer/messages"
)

const port = 7777

var (
	client_list       map[net.Conn]messages.ClientInfo = make(map[net.Conn]messages.ClientInfo, 16)
	client_list_mutex sync.Mutex
)

func main() {
	if len(os.Args) == 1 {
		fmt.Println("Please provide host:port")
		os.Exit(1)
	}

	// Resolve the string address to a TCP address
	tcpAddr, err := net.ResolveTCPAddr("tcp4", fmt.Sprintf("localhost:%d", port))
	if err != nil {
		panic(err)
	}

	// Start listening for TCP connections on the given address
	listener, err := net.ListenTCP("tcp", tcpAddr)
	if err != nil {
		panic(err)
	}

	for {
		// Accept new connections
		conn, err := listener.Accept()
		if err != nil {
			fmt.Println(err)
			continue
		}
		// Handle new connections in a Goroutine for concurrency
		go handleConnection(conn)
	}
}

func handleConnection(conn net.Conn) {
	defer conn.Close()

	defer func() {
		if err := recover(); err != nil {
			fmt.Println("Server Error")
		}
	}()

	regReq, errCode := messages.ReadRegistrationRequestMessage(conn)
	if errCode != messages.NoError {
		messages.WriteErrorMessage(conn, errCode)
		return
	}

	client_list_mutex.Lock()
	client_list[conn] = regReq.Client

	messages.WriteRegistrationResponse(conn, client_list)

	client_list_mutex.Unlock()

	res := []byte{0}
	_, err := conn.Read(res)
	if err != nil {
		panic(err)
	}

	if res[0] != byte(messages.ClientListRecieved) {
		fmt.Printf("Expected ClientListRecieved (3) but got %d\n", res[0])
		return
	}

	client_list_mutex.Lock()

	for client_conn := range client_list {
		if client_conn == conn {
			continue
		}

		messages.WriteNewClientConnectedMessage(client_conn, regReq.Client)
	}

	client_list_mutex.Unlock()

	for {
		msg_id := []byte{0}
		_, err := conn.Read(msg_id)

		if err == io.EOF {
			fmt.Printf("Client Disconnected")
			return
		}

		if err != nil {
			panic(err)
		}

		switch messages.MessageID(msg_id[0]) {
		case messages.Broadcast:
			msg := messages.ReadBroadcastMessage(conn)
			client_list_mutex.Lock()

			for client_conn := range client_list {
				messages.WriteBroadcastMessage(client_conn, msg.Message)
			}

			client_list_mutex.Unlock()
		case messages.ClientDisconnectedS2C:
			client_list_mutex.Lock()

			for client_conn := range client_list {
				if client_conn == conn {
					continue
				}

				messages.WriteClientDisconnectMessage(client_conn, regReq.Client.Name)
			}

			client_list_mutex.Unlock()
		default:
			messages.WriteErrorMessage(conn, messages.InvalidMessageID)
		}
	}
}

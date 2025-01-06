package main

import (
	"encoding/binary"
	"fmt"
	"log/slog"
	"net"
	"sync"

	"github.com/bafto/PeerToPeer/messages"
)

const port = 7777

var (
	client_list       map[net.Conn]messages.ClientInfo = make(map[net.Conn]messages.ClientInfo, 16)
	client_list_mutex sync.Mutex
)

func main() {
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

	slog.Info("listening for connections")
	for {
		// Accept new connections
		conn, err := listener.Accept()
		if err != nil {
			slog.Error("error accepting connection", "err", err)
			continue
		}
		slog.Info("got a new connection", "remote-addr", conn.RemoteAddr())
		// Handle new connections in a Goroutine for concurrency
		go handleConnection(conn)
	}
}

func handleConnection(conn net.Conn) {
	defer conn.Close()

	defer func() {
		if err := recover(); err != nil {
			slog.Error("Server Error", "err", err)
		}
	}()

	regReq, errCode := messages.ReadRegistrationRequestMessage(conn)
	if errCode != messages.NoError {
		slog.Warn("error reading registration message", "error-code", errCode)
		messages.WriteErrorMessage(conn, errCode)
		return
	}
	slog.Info("read registration request")

	func() {
		client_list_mutex.Lock()
		defer client_list_mutex.Unlock()
		for _, info := range client_list {
			host, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
			if info.Client_port == regReq.Client.Client_port && host == regReq.Client.Client_ip.String() {
				messages.WriteErrorMessage(conn, messages.IPPortNotUnique)
				return
			}
		}

		client_list[conn] = regReq.Client

		messages.WriteRegistrationResponse(conn, client_list)

		for client_conn := range client_list {
			if client_conn == conn {
				continue
			}

			messages.WriteNewClientConnectedMessage(client_conn, regReq.Client)
		}
	}()

	broadcastClientDisconnect := func() {
		for client_conn := range client_list {
			if client_conn == conn {
				continue
			}

			messages.WriteClientDisconnectMessage(client_conn, regReq.Client.Name)
		}
	}

	slog.Info("handling connection")
	for {
		msg_id := messages.MessageID(0)
		err := binary.Read(conn, binary.LittleEndian, &msg_id)
		if err != nil {
			slog.Info("Client Disconnected", "remote-addr", conn.RemoteAddr())

			func() {
				client_list_mutex.Lock()
				defer client_list_mutex.Unlock()

				if _, ok := client_list[conn]; ok {
					slog.Warn("Client did not yet send a disconnect message")
					broadcastClientDisconnect()
				}
			}()
			return
		}

		switch msg_id {
		case messages.Broadcast:
			msg := messages.ReadBroadcastMessage(conn)
			func() {
				client_list_mutex.Lock()

				for client_conn := range client_list {
					messages.WriteBroadcastMessage(client_conn, msg.Message)
				}

				defer client_list_mutex.Unlock()
			}()

		case messages.DisconnectC2S:
			func() {
				client_list_mutex.Lock()
				defer client_list_mutex.Unlock()

				broadcastClientDisconnect()
				delete(client_list, conn)
			}()
		case messages.Error:
			code := messages.ReadError(conn)
			slog.Error("Client responded with error", "code", code)
		default:
			slog.Warn("got invalid msg id from client", "msg-id", msg_id)
			messages.WriteErrorMessage(conn, messages.InvalidMessageID)
		}
	}
}

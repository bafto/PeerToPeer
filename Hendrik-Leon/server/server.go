package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"unicode/utf8"
)

type ErrorCode byte
type MessageID byte

const (
	Error MessageID = iota
	RegistrationRequest
	RegistrationResponse
	ClientListRecieved
	NewClientConnected
	ClientDisconnectedS2C
	Broadcast
	DisconnectC2S
)

const (
	InvalidMessageID ErrorCode = iota
	IPPortNotUnique
	NameNotUnique
	NameLengthZero
	NameNotUTF8
	InvalidClientList
	NoError = 255
)

type ClientInfo struct {
	client_ip   net.IP
	client_port uint16
	name_len    byte
	name        string
}

// Messages

type ErrorMessage struct {
	message_id MessageID
	errorCode  ErrorCode
}

type RegistrationRequestMessage struct {
	message_id MessageID
	client     ClientInfo
}

type RegistrationResponseMessage struct {
	message_id MessageID
	n_clients  uint32
	clients    []ClientInfo
}

type NewClientConnectedMessage struct {
	message_id MessageID
	client     ClientInfo
}

type ClientDisconnectedMessage struct {
	message_id MessageID
	name_len   byte
	name       string
}

type BroadcastMessage struct {
	message_id  MessageID
	message_len uint16
	message     string
}

const port = 7777

var client_list map[net.Conn]ClientInfo = make(map[net.Conn]ClientInfo, 16)
var client_list_mutex sync.Mutex

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

func UnmarshalRegistrationRequestMessage(conn io.Reader) (RegistrationRequestMessage, ErrorCode) {
	m := make([]byte, 8)
	_, err := conn.Read(m[:1])
	if err != nil {
		panic(err)
	}

	if m[0] != byte(RegistrationRequest) {
		return RegistrationRequestMessage{}, InvalidMessageID
	}

	_, err = conn.Read(m[1:5])
	if err != nil {
		panic(err)
	}

	_, err = conn.Read(m[5:7])
	if err != nil {
		panic(err)
	}

	_, err = conn.Read(m[7:8])
	if err != nil {
		panic(err)
	}

	if m[7] == 0 {
		return RegistrationRequestMessage{}, NameLengthZero
	}

	name := make([]byte, m[7])
	_, err = conn.Read(name)
	if err != nil {
		panic(err)
	}

	if !utf8.Valid(name) {
		return RegistrationRequestMessage{}, NameNotUTF8
	}

	return RegistrationRequestMessage{
		message_id: MessageID(m[0]),
		client: ClientInfo{
			client_ip:   m[1:5],
			client_port: binary.BigEndian.Uint16(m[5:7]),
			name_len:    m[7],
			name:        string(name),
		},
	}, NoError
}

func WriteClientInfo(w io.Writer, info ClientInfo) {
	w.Write(info.client_ip)
	binary.Write(w, binary.BigEndian, info.client_port)
	binary.Write(w, binary.BigEndian, info.name_len)
	binary.Write(w, binary.BigEndian, []byte(info.name))
}

func WriteRegistrationResponse(w io.Writer, list map[net.Conn]ClientInfo) {
	binary.Write(w, binary.BigEndian, byte(RegistrationResponse))
	binary.Write(w, binary.BigEndian, uint32(len(list)))

	for _, info := range list {
		WriteClientInfo(w, info)
	}
}

func WriteBroadcastMessage(w io.Writer, msg string) {
	binary.Write(w, binary.BigEndian, byte(Broadcast))
	binary.Write(w, binary.BigEndian, uint32(len(msg)))
	w.Write([]byte(msg))
}

// already read message ID
func ReadBroadcastMessage(r io.Reader) BroadcastMessage {
	msg_len := make([]byte, 4)
	_, err := r.Read(msg_len)
	if err != nil {
		panic(err)
	}

	msg_len_16 := binary.BigEndian.Uint16(msg_len)
	msg := make([]byte, msg_len_16)
	_, err = r.Read(msg)
	if err != nil {
		panic(err)
	}

	return BroadcastMessage{
		message_id:  Broadcast,
		message_len: msg_len_16,
		message:     string(msg),
	}
}

func WriteClientDisconnectMessage(w io.Writer, name string) {
	binary.Write(w, binary.BigEndian, byte(ClientDisconnectedS2C))
	binary.Write(w, binary.BigEndian, byte(len(name)))
	w.Write([]byte(name))
}

func WriteNewClientConnectedMessage(w io.Writer, client ClientInfo) {
	binary.Write(w, binary.BigEndian, byte(NewClientConnected))
	WriteClientInfo(w, client)
}

func writeError(w io.Writer, code ErrorCode) {
	_, err := w.Write([]byte{byte(Error), byte(code)})
	if err != nil {
		panic(err)
	}
}

func handleConnection(conn net.Conn) {
	defer conn.Close()

	defer func() {
		if err := recover(); err != nil {
			fmt.Println("Server Error")
		}
	}()

	regReq, errCode := UnmarshalRegistrationRequestMessage(conn)
	if errCode != NoError {
		writeError(conn, errCode)
		return
	}

	client_list_mutex.Lock()
	client_list[conn] = regReq.client

	WriteRegistrationResponse(conn, client_list)

	client_list_mutex.Unlock()

	res := []byte{0}
	_, err := conn.Read(res)
	if err != nil {
		panic(err)
	}

	if res[0] != byte(ClientListRecieved) {
		fmt.Printf("Expected ClientListRecieved (3) but got %d\n", res[0])
		return
	}

	client_list_mutex.Lock()

	for client_conn := range client_list {
		if client_conn == conn {
			continue
		}

		WriteNewClientConnectedMessage(client_conn, regReq.client)
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

		switch MessageID(msg_id[0]) {
		case Broadcast:
			msg := ReadBroadcastMessage(conn)
			client_list_mutex.Lock()

			for client_conn := range client_list {
				WriteBroadcastMessage(client_conn, msg.message)
			}

			client_list_mutex.Unlock()
		case ClientDisconnectedS2C:
			client_list_mutex.Lock()

			for client_conn := range client_list {
				if client_conn == conn {
					continue
				}

				WriteClientDisconnectMessage(client_conn, regReq.client.name)
			}

			client_list_mutex.Unlock()
		default:
			writeError(conn, InvalidMessageID)
		}
	}
}

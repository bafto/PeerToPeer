package messages

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"unicode/utf8"
)

var ByteOrder = binary.LittleEndian

type (
	ErrorCode byte
	MessageID byte
)

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
	Client_ip   net.IP
	Client_port uint16
	Name_len    byte
	Name        string
}

func WriteClientInfo(w io.Writer, info ClientInfo) {
	w.Write([]byte(info.Client_ip))
	binary.Write(w, ByteOrder, info.Client_port)
	binary.Write(w, ByteOrder, info.Name_len)
	binary.Write(w, ByteOrder, []byte(info.Name))
}

func ReadClientInfo(r io.Reader) ClientInfo {
	ip_slice := [4]byte{}
	r.Read(ip_slice[:])
	port_slice := [2]byte{}
	r.Read(port_slice[:])
	name_len := [1]byte{}
	r.Read(name_len[:])
	name := make([]byte, name_len[0])
	r.Read(name)

	return ClientInfo{
		Client_ip:   net.IP(ip_slice[:]),
		Client_port: ByteOrder.Uint16(port_slice[:]),
		Name_len:    name_len[0],
		Name:        string(name),
	}
}

// Messages

type ErrorMessage struct {
	Message_id MessageID
	ErrorCode  ErrorCode
}

func WriteErrorMessage(w io.Writer, code ErrorCode) {
	_, err := w.Write([]byte{byte(Error), byte(code)})
	if err != nil {
		panic(err)
	}
}

type RegistrationRequestMessage struct {
	Message_id MessageID
	Client     ClientInfo
}

func ReadRegistrationRequestMessage(conn io.Reader) (RegistrationRequestMessage, ErrorCode) {
	m := [8]byte{}
	_, err := conn.Read(m[:1])
	if err != nil {
		panic(err)
	}

	if m[0] != byte(RegistrationRequest) {
		return RegistrationRequestMessage{}, InvalidMessageID
	}

	_, err = io.ReadFull(conn, m[1:])
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
		Message_id: MessageID(m[0]),
		Client: ClientInfo{
			Client_ip:   m[1:5],
			Client_port: ByteOrder.Uint16(m[5:7]),
			Name_len:    m[7],
			Name:        string(name),
		},
	}, NoError
}

func WriteRegistrationRequest(w io.Writer, client_ip net.IP, client_port uint16, name string) error {
	if len(name) > 255 {
		return fmt.Errorf("the length of name may not exceed 255 bytes")
	}
	if len(name) == 0 {
		return fmt.Errorf("name length must be greater than 0")
	}

	w.Write([]byte{byte(RegistrationRequest)})
	WriteClientInfo(w, ClientInfo{
		Client_ip:   client_ip,
		Client_port: client_port,
		Name_len:    byte(len(name)),
		Name:        name,
	})
	return nil
}

type RegistrationResponseMessage struct {
	Message_id MessageID
	N_clients  uint32
	Clients    []ClientInfo
}

func WriteRegistrationResponse(w io.Writer, list map[net.Conn]ClientInfo) {
	binary.Write(w, ByteOrder, byte(RegistrationResponse))
	binary.Write(w, ByteOrder, uint32(len(list)))

	for _, info := range list {
		WriteClientInfo(w, info)
	}
}

func ReadRegistrationResponseMessage(r io.Reader) (RegistrationResponseMessage, error) {
	message_id := [1]byte{}
	r.Read(message_id[:])
	if MessageID(message_id[0]) != RegistrationResponse {
		return RegistrationResponseMessage{}, fmt.Errorf("Server responded with invalid message ID (%d)", message_id[0])
	}

	n_clients_slice := [4]byte{}
	r.Read(n_clients_slice[:])
	n_clients := ByteOrder.Uint32(n_clients_slice[:])
	client_infos := make([]ClientInfo, 0, n_clients)
	for range n_clients {
		client_infos = append(client_infos, ReadClientInfo(r))
	}
	return RegistrationResponseMessage{
		Message_id: RegistrationResponse,
		N_clients:  n_clients,
		Clients:    client_infos,
	}, nil
}

type BroadcastMessage struct {
	Message_id  MessageID
	Message_len uint16
	Message     string
}

func WriteBroadcastMessage(w io.Writer, msg string) {
	binary.Write(w, ByteOrder, byte(Broadcast))
	binary.Write(w, ByteOrder, uint32(len(msg)))
	w.Write([]byte(msg))
}

// already read message ID
func ReadBroadcastMessage(r io.Reader) BroadcastMessage {
	msg_len := make([]byte, 4)
	_, err := r.Read(msg_len)
	if err != nil {
		panic(err)
	}

	msg_len_16 := ByteOrder.Uint16(msg_len)
	msg := make([]byte, msg_len_16)
	_, err = r.Read(msg)
	if err != nil {
		panic(err)
	}

	return BroadcastMessage{
		Message_id:  Broadcast,
		Message_len: msg_len_16,
		Message:     string(msg),
	}
}

type NewClientConnectedMessage struct {
	Message_id MessageID
	Client     ClientInfo
}

func WriteNewClientConnectedMessage(w io.Writer, client ClientInfo) {
	binary.Write(w, ByteOrder, byte(NewClientConnected))
	WriteClientInfo(w, client)
}

type ClientDisconnectedMessage struct {
	Message_id MessageID
	Name_len   byte
	Name       string
}

func WriteClientDisconnectMessage(w io.Writer, name string) {
	binary.Write(w, ByteOrder, byte(ClientDisconnectedS2C))
	binary.Write(w, ByteOrder, byte(len(name)))
	w.Write([]byte(name))
}

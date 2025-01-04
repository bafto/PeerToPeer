package messages

import (
	"encoding/binary"
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
	w.Write(info.Client_ip)
	binary.Write(w, ByteOrder, info.Client_port)
	binary.Write(w, ByteOrder, info.Name_len)
	binary.Write(w, ByteOrder, []byte(info.Name))
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
		Message_id: MessageID(m[0]),
		Client: ClientInfo{
			Client_ip:   m[1:5],
			Client_port: ByteOrder.Uint16(m[5:7]),
			Name_len:    m[7],
			Name:        string(name),
		},
	}, NoError
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

package messages

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"unicode/utf8"
)

var ByteOrder = binary.BigEndian

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
	PeerToPeerRequest
	PeerToPeerMessage
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
	_, err := r.Read(ip_slice[:])
	if err != nil {
		panic(err)
	}
	port_slice := [2]byte{}
	_, err = r.Read(port_slice[:])
	if err != nil {
		panic(err)
	}
	name_len := [1]byte{}
	_, err = r.Read(name_len[:])
	if err != nil {
		panic(err)
	}
	name := make([]byte, name_len[0])
	_, err = r.Read(name)
	if err != nil {
		panic(err)
	}

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
	if err := binary.Write(w, ByteOrder, []byte{byte(Error), byte(code)}); err != nil {
		panic(err)
	}
}

func ReadError(r io.Reader) ErrorCode {
	code := ErrorCode(0)
	binary.Read(r, ByteOrder, &code)
	return code
}

type RegistrationRequestMessage struct {
	Message_id MessageID
	Client     ClientInfo
}

func ReadRegistrationRequestMessage(conn io.Reader) (RegistrationRequestMessage, ErrorCode) {
	m := [8]byte{}
	err := binary.Read(conn, ByteOrder, m[:1])
	if err != nil {
		panic(err)
	}

	if m[0] != byte(RegistrationRequest) {
		return RegistrationRequestMessage{}, InvalidMessageID
	}

	err = binary.Read(conn, ByteOrder, m[1:])
	if err != nil {
		panic(err)
	}

	if m[7] == 0 {
		return RegistrationRequestMessage{}, NameLengthZero
	}

	name := make([]byte, m[7])
	err = binary.Read(conn, ByteOrder, name)
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

	binary.Write(w, ByteOrder, byte(RegistrationRequest))
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

// assumes message_id was already read
func ReadRegistrationResponseMessage(r io.Reader) (RegistrationResponseMessage, error) {
	n_clients_slice := [4]byte{}
	err := binary.Read(r, ByteOrder, &n_clients_slice)
	if err != nil {
		return RegistrationResponseMessage{}, err
	}
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
	binary.Write(w, ByteOrder, uint16(len(msg)))
	binary.Write(w, ByteOrder, []byte(msg))
}

// already read message ID
func ReadBroadcastMessage(r io.Reader) BroadcastMessage {
	msg_len := make([]byte, 2)
	_, err := r.Read(msg_len)
	// err := binary.Read(r, ByteOrder, msg_len)
	if err != nil {
		panic(err)
	}

	msg_len_16 := ByteOrder.Uint16(msg_len)
	msg := make([]byte, msg_len_16)
	err = binary.Read(r, ByteOrder, msg)
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

// assumes message_id was already read
func ReadNewClientConnectedMessage(r io.Reader) NewClientConnectedMessage {
	return NewClientConnectedMessage{
		Message_id: NewClientConnected,
		Client:     ReadClientInfo(r),
	}
}

type ClientDisconnectedMessage struct {
	Message_id MessageID
	Name_len   byte
	Name       string
}

func WriteClientDisconnectMessage(w io.Writer, name string) {
	binary.Write(w, ByteOrder, byte(ClientDisconnectedS2C))
	binary.Write(w, ByteOrder, byte(len(name)))
	binary.Write(w, ByteOrder, []byte(name))
}

// assumes message_id was already read
func ReadClientDisconnectMessage(r io.Reader) ClientDisconnectedMessage {
	name_len := byte(0)
	binary.Read(r, ByteOrder, &name_len)
	name := make([]byte, name_len)
	binary.Read(r, ByteOrder, name)
	return ClientDisconnectedMessage{
		Message_id: ClientDisconnectedS2C,
		Name_len:   name_len,
		Name:       string(name),
	}
}

type PeerToPeerRequestMessage struct {
	Message_id MessageID
	Tcp_port   uint16
	Name_len   byte
	Name       string
}

func WritePeerToPeerRequestMessage(w io.Writer, tcp_port uint16, nickname string) error {
	msg := []byte{byte(PeerToPeerRequest), 0, 0}
	ByteOrder.PutUint16(msg[1:], tcp_port)
	msg = append(msg, byte(len(nickname)))
	msg = append(msg, []byte(nickname)...)
	return binary.Write(w, ByteOrder, msg)
}

func ReadPeerToPeerRequestMessage(conn *net.UDPConn) (PeerToPeerRequestMessage, *net.UDPAddr, ErrorCode) {
	b := [260]byte{}
	_, addr, _ := conn.ReadFromUDP(b[:])

	// b := [260]byte{}
	// binary.Read(bytes.NewReader(b_raw[:]), ByteOrder, b)

	if b[0] != byte(PeerToPeerRequest) {
		return PeerToPeerRequestMessage{}, nil, InvalidMessageID
	}
	name_len := b[3]

	return PeerToPeerRequestMessage{
		Message_id: PeerToPeerRequest,
		Tcp_port:   ByteOrder.Uint16(b[1:3]),
		Name_len:   name_len,
		Name:       string(b[4 : 4+name_len]),
	}, addr, NoError
}

type PeerToPeerMessageMessage struct {
	Message_id MessageID
	Msg_len    uint16
	Msg        string
}

func WritePeerToPeerMessage(w io.Writer, msg string) error {
	if uint16(len(msg)) > ^uint16(0) {
		return fmt.Errorf("message is too long!")
	}

	binary.Write(w, ByteOrder, byte(PeerToPeerMessage))
	binary.Write(w, ByteOrder, uint16(len(msg)))
	binary.Write(w, ByteOrder, []byte(msg))
	return nil
}

// assumes message_id was already read
func ReadPeerToPeerMessage(r io.Reader) PeerToPeerMessageMessage {
	msg_len_slice := [2]byte{}
	r.Read(msg_len_slice[:])
	msg_len := ByteOrder.Uint16(msg_len_slice[:])

	msg := make([]byte, msg_len)
	binary.Read(r, ByteOrder, msg)
	return PeerToPeerMessageMessage{
		Message_id: PeerToPeerMessage,
		Msg_len:    msg_len,
		Msg:        string(msg),
	}
}

package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/bafto/PeerToPeer/messages"
)

const (
	server_port  = 7777
	read_timeout = time.Second * 5
)

var client_port uint16 = 7778

func main() {
	if len(os.Args) > 1 {
		port, err := strconv.ParseUint(os.Args[1], 10, 16)
		if err != nil {
			panic("invalid port!")
		}
		client_port = uint16(port)
	}

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
	connected_peers   = sync.Map{}
	current_port      = atomic.Uint32{}
)

func handleConnection(conn net.Conn) {
	defer conn.Close()
	stdinReader := bufio.NewReader(os.Stdin)
	fmt.Printf("Enter your nickname: ")
	name, _ := stdinReader.ReadString('\n')
	name = strings.Trim(name, "\r\n")

	fmt.Println("registering at server...")
	if err := messages.WriteRegistrationRequest(conn, []byte{127, 0, 0, 1}, client_port, name); err != nil {
		fmt.Printf("Error connecting to server: %s\n", err)
		os.Exit(1)
	}

	message_id := [1]byte{}
	conn.Read(message_id[:])

	if messages.MessageID(message_id[0]) == messages.Error {
		fmt.Printf("Server responded with error (%d)\n", messages.ReadError(conn))
		os.Exit(1)
	}

	if messages.MessageID(message_id[0]) != messages.RegistrationResponse {
		fmt.Printf("Server responded with invalid message ID (%d)\n", message_id[0])
		os.Exit(1)
	}

	fmt.Println("reading registration response")
	regResp, err := messages.ReadRegistrationResponseMessage(conn)
	if err != nil {
		fmt.Printf("Error reading registration response from server: %s\n", err)
		os.Exit(1)
	}

	func() {
		client_list_mutex.Lock()
		defer client_list_mutex.Unlock()
		for _, client := range regResp.Clients {
			client_list[client.Name] = client
		}
	}()

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

	wg.Add(3)
	go handleServer(conn, &wg, log)
	go handleUserInput(stdinReader, conn, name, &wg, log)
	go handlePeerToPeerChatClient(&wg, log)

	go func() {
		wg.Wait()
		closeClientChan <- syscall.SIGTERM
	}()

	<-closeClientChan
	fmt.Println("closing client")
	sendDisconnectMessage(conn)
}

func handleServer(conn net.Conn, wg *sync.WaitGroup, log chan string) {
	defer wg.Done()
	for {
		msg_id := []byte{0}
		_, err := conn.Read(msg_id)
		if err != nil {
			log <- "connection to server lost"
			return
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
}

const help = `You can now enter the following commands:
	help: display this help
	clients: print all connected clients
	broadcast <message>: broadcast <message> to all other clients
	chat <nickname>: send a peer-to-peer chat request to <nickname> or (if already connected) send a message`

func handleUserInput(stdin *bufio.Reader, conn net.Conn, name string, wg *sync.WaitGroup, log chan<- string) {
	defer wg.Done()
	log <- help
	for {
		line, err := stdin.ReadString('\n')
		if err == io.EOF {
			return
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
		case "clients":
			clients := ""
			client_list_mutex.Lock()
			for nickname := range client_list {
				clients += nickname + "\n"
			}
			client_list_mutex.Unlock()
			log <- clients
		case "chat":
			if len(cmds) < 2 {
				log <- "You need to enter a nickname to chat with!"
				break
			}

			nickname := cmds[1]

			if nickname == name {
				log <- "You cannot chat with yourself!"
				break
			}

			if peerConn, ok := connected_peers.Load(nickname); ok {
				if len(cmds) < 3 {
					log <- "You have to enter a message to send!"
					break
				}

				log <- "sending message to " + nickname
				messages.WritePeerToPeerMessage(peerConn.(net.Conn), strings.Join(cmds[2:], " "))
				break
			}

			var client_info messages.ClientInfo
			client_list_mutex.Lock()
			if info, ok := client_list[nickname]; !ok {
				log <- "The nickname does not exist!"
				client_list_mutex.Unlock()
				break
			} else {
				client_info = info
			}
			client_list_mutex.Unlock()

			connectPeerToPeer(client_info, name, wg, log)
		default:
			log <- "unknown command '" + cmds[0] + "'"
		}
	}
}

func connectPeerToPeer(client_info messages.ClientInfo, nickname string, wg *sync.WaitGroup, log chan<- string) {
	log <- "connecting to " + client_info.Name
	udpAddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", client_info.Client_ip.String(), client_info.Client_port))
	if err != nil {
		log <- "could not resolve client address: " + err.Error()
		return
	}

	conn, err := net.DialUDP("udp", nil, udpAddr)
	if err != nil {
		log <- "could not connect to peer: " + err.Error()
		return
	}

	tcp_port := uint16(current_port.Add(1))
	connected := make(chan struct{})
	handlePeerToPeerChatServer(tcp_port, client_info.Name, connected, wg, log)

	timer := time.NewTimer(time.Second * 2)

	if err := messages.WritePeerToPeerRequestMessage(conn, tcp_port, nickname); err != nil {
		log <- "Failed to request peer to peer chat: " + err.Error()
		return
	}

	for range 3 {
		select {
		case <-timer.C:
			log <- "retrying peer connection"
			timer.Reset(time.Second * 2)
			if err := messages.WritePeerToPeerRequestMessage(conn, tcp_port, nickname); err != nil {
				log <- "Failed to request peer to peer chat: " + err.Error()
			}
		case <-connected:
			log <- "connected to " + client_info.Name
			return
		}
	}
	log <- "could not connect to " + client_info.Name
}

func handlePeerToPeerChatServer(tcp_port uint16, nickname string, connected chan<- struct{}, wg *sync.WaitGroup, log chan<- string) error {
	tcpAddr, err := net.ResolveTCPAddr("tcp4", fmt.Sprintf("localhost:%d", tcp_port))
	if err != nil {
		return err
	}

	// Start listening for TCP connections on the given address
	listener, err := net.ListenTCP("tcp", tcpAddr)
	if err != nil {
		return err
	}

	wg.Add(1)
	go func() {
		defer wg.Done()

		conn, err := listener.Accept()
		if err != nil {
			log <- "Error accepting peer to peer connection: " + err.Error()
			return
		}
		connected <- struct{}{}

		connected_peers.Store(nickname, conn)
		handlePeerToPeerMessages(conn, nickname, log)
		connected_peers.Delete(nickname)
	}()
	return nil
}

func handlePeerToPeerChatClient(wg *sync.WaitGroup, log chan<- string) {
	defer wg.Done()

	udpAddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", "localhost", client_port))
	if err != nil {
		log <- "could not resolve client address: " + err.Error()
		return
	}

	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		log <- "error listening to udp connections: " + err.Error()
		return
	}

	for {
		req, addr, err_code := messages.ReadPeerToPeerRequestMessage(conn)
		if err_code != messages.NoError {
			messages.WriteErrorMessage(conn, err_code)
			continue
		}

		tcpAddr, err := net.ResolveTCPAddr("tcp4", fmt.Sprintf("%s:%d", addr.IP, req.Tcp_port))
		if err != nil {
			log <- "Error resolving tcp addr: " + err.Error()
			continue
		}

		peerConn, err := net.DialTCP("tcp", nil, tcpAddr)
		if err != nil {
			log <- "Error connecting to peer: " + err.Error()
			continue
		}

		wg.Add(1)
		go func() {
			defer wg.Done()

			connected_peers.Store(req.Name, peerConn)
			go handlePeerToPeerMessages(peerConn, req.Name, log)
		}()
	}
}

func handlePeerToPeerMessages(conn net.Conn, nickname string, log chan<- string) {
	log <- "handling peer messages with " + nickname
	for {
		msg_id := []byte{0}
		_, err := conn.Read(msg_id)
		if err != nil {
			log <- "error reading from peer to peer connection"
			return
		}
		log <- "got message from " + nickname

		switch messages.MessageID(msg_id[0]) {
		case messages.PeerToPeerMessage:
			msg := messages.ReadPeerToPeerMessage(conn)
			log <- nickname + ": " + msg.Msg
		case messages.Error:
			log <- fmt.Sprintf("Error from %s: %d", nickname, messages.ReadError(conn))
		default:
			messages.WriteErrorMessage(conn, messages.InvalidMessageID)
		}

	}
}

func sendDisconnectMessage(conn net.Conn) {
	conn.Write([]byte{byte(messages.DisconnectC2S)})
}

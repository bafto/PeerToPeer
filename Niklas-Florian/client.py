import socket
import struct
import threading

SERVER_IP = '127.0.0.1'
SERVER_PORT = 7777
UDP_PORT = 5556  # Ein anderer Port als der erste Client


def listen_udp():
    """Hört auf UDP-Nachrichten für Peer-to-Peer-Chat-Anfragen und Broadcasts."""
    udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp_socket.bind(('0.0.0.0', UDP_PORT))
    while True:
        data, addr = udp_socket.recvfrom(1024)
        msg_id = data[0]
        if msg_id == 6:  # Broadcast
            msg_len = struct.unpack("!H", data[1:3])[0]
            message = data[3:3 + msg_len].decode('utf-8')
            print(f"Broadcast: {message}")
        elif msg_id == 8:  # P2P Anfrage
            tcp_port = struct.unpack("!H", data[1:3])[0]
            print(f"Peer-to-Peer Anfrage von {addr}: TCP Port {tcp_port}")
            threading.Thread(target=start_p2p_chat, args=(addr[0], tcp_port)).start()


def start_p2p_chat(peer_ip, peer_tcp_port):
    """Startet eine Peer-to-Peer-Chat-Verbindung."""
    try:
        peer_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        peer_socket.connect((peer_ip, peer_tcp_port))
        print(f"Peer-to-Peer-Chat mit {peer_ip}:{peer_tcp_port} gestartet.")
        while True:
            msg = input("P2P Nachricht (exit zum Beenden): ")
            if msg == 'exit':
                break
            msg_data = struct.pack("!BH", 9, len(msg)) + msg.encode('utf-8')
            peer_socket.send(msg_data)
    except Exception as e:
        print(f"Fehler beim Peer-to-Peer-Chat: {e}")
    finally:
        peer_socket.close()


def accept_p2p_connections(tcp_port):
    """Akzeptiert eingehende Peer-to-Peer-Chat-Verbindungen."""
    p2p_server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    p2p_server.bind(('0.0.0.0', tcp_port))
    p2p_server.listen(1)
    print(f"Warten auf Peer-to-Peer-Verbindungen auf Port {tcp_port}...")
    while True:
        conn, addr = p2p_server.accept()
        print(f"Peer-to-Peer-Verbindung von {addr}")
        threading.Thread(target=handle_p2p_connection, args=(conn,)).start()


def handle_p2p_connection(conn):
    """Verarbeitet eingehende P2P-Nachrichten."""
    try:
        while True:
            data = conn.recv(1024)
            if not data:
                break
            msg_id = data[0]
            if msg_id == 9:
                msg_len = struct.unpack("!H", data[1:3])[0]
                message = data[3:3 + msg_len].decode('utf-8')
                print(f"P2P Nachricht: {message}")
    except Exception as e:
        print(f"Fehler in Peer-to-Peer-Verbindung: {e}")
    finally:
        conn.close()


def main():
    nickname = input("Gib deinen Nickname ein: ")
    tcp_port = int(input("Gib deinen TCP-Port für Peer-to-Peer an (z.B. 6000): "))

    # TCP-Verbindung zum Server
    tcp_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    tcp_socket.connect((SERVER_IP, SERVER_PORT))

    # Registrierung
    reg_msg = struct.pack("!B", 1)  # Msg-ID
    reg_msg += socket.inet_aton(socket.gethostbyname(socket.gethostname()))
    reg_msg += struct.pack("!H", UDP_PORT)
    reg_msg += struct.pack("!B", len(nickname)) + nickname.encode('utf-8')
    tcp_socket.send(reg_msg)

    # Empfang der Client-Liste
    data = tcp_socket.recv(1024)
    if data[0] != 2:  # Registrierung fehlgeschlagen
        print("Registrierung fehlgeschlagen")
        tcp_socket.close()
        return

    client_count = struct.unpack("!I", data[1:5])[0]
    print(f"Verbundene Clients: {client_count}")
    offset = 5
    for _ in range(client_count):
        ip = socket.inet_ntoa(data[offset:offset + 4])
        port = struct.unpack("!H", data[offset + 4:offset + 6])[0]
        name_len = data[offset + 6]
        name = data[offset + 7:offset + 7 + name_len].decode('utf-8')
        print(f"{name} bei {ip}:{port}")
        offset += 7 + name_len

    threading.Thread(target=listen_udp, daemon=True).start()
    threading.Thread(target=accept_p2p_connections, args=(tcp_port,), daemon=True).start()

    while True:
        cmd = input("Befehl (broadcast, p2p, exit): ")
        if cmd == 'broadcast':
            message = input("Gib die Broadcast-Nachricht ein: ")
            msg = struct.pack("!BH", 6, len(message)) + message.encode('utf-8')
            tcp_socket.send(msg)
        elif cmd == 'p2p':
            peer_ip = input("IP des Peers: ")
            peer_udp_port = int(input("UDP-Port des Peers: "))

            udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            p2p_request = struct.pack("!BH", 8, tcp_port)
            udp_socket.sendto(p2p_request, (peer_ip, peer_udp_port))
            udp_socket.close()
        elif cmd == 'exit':
            tcp_socket.send(struct.pack("!B", 7))
            break

    tcp_socket.close()


if __name__ == "__main__":
    main()

import socket
import struct
import threading
import time
import argparse

# Globale Variablen
running = True
clients = {}  # Hier speichern wir die Client-Informationen als Dictionary

# Sockets für TCP und UDP erstellen
tcp_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

def recv_with_timeout(client_socket, expected_length, timeout):

    data = b''  # Leerer Puffer für die empfangenen Daten
    start_time = time.time()  # Zeitstempel für Timeout

    while len(data) < expected_length:
        remaining_time = timeout - (time.time() - start_time)
        if remaining_time <= 0:
            print("Timeout erreicht, bevor die erwarteten Daten empfangen wurden.")
            return None

        # Empfange Daten mit der verbleibenden Zeit
        chunk = client_socket.recv(min(1024, expected_length - len(data)))

        if not chunk:  # Verbindung wurde geschlossen oder ein Fehler ist aufgetreten
            print("Verbindung geschlossen oder Fehler beim Empfangen.")
            return None
        
        data += chunk

    return data


# Registrierung beim Server
def register_with_server(nickname, server_host, server_port, udp_port):
    try:
        tcp_socket.connect((server_host, server_port))
        print(f"Verbunden mit Server {server_host}:{server_port}")
        
        ip = socket.inet_aton(socket.gethostbyname(socket.gethostname()))
        msg = struct.pack('!B4sH B', 1, ip, udp_port, len(nickname)) + nickname.encode('utf-8')
        tcp_socket.send(msg)
        
        response = tcp_socket.recv(1024)
        msg_id, num_clients = struct.unpack('!B I', response[:5])
        print(f"Erfolgreich registriert. {num_clients} andere Clients online.")

        # Clients aus der Antwort extrahieren und speichern
        if msg_id == 2:
            idx = 5
            while idx < len(response):
                ip = socket.inet_ntoa(response[idx:idx+4])
                udp_port = struct.unpack('!H', response[idx+4:idx+6])[0]
                name_len = response[idx+6]
                name = response[idx+7:idx+7+name_len].decode('utf-8')
                clients[name] = {'ip': ip, 'udp_port': udp_port}
                idx += 7 + name_len

    except Exception as e:
        print(f"Fehler bei der Registrierung: {e}")
        tcp_socket.close()

# Broadcast senden
def send_broadcast(message):
    try:
        msg = struct.pack('!B H', 6, len(message)) + message.encode('utf-8')
        tcp_socket.send(msg)
        print("Broadcast gesendet.")
    except Exception as e:
        print(f"Fehler beim Broadcast: {e}")

# Peer-to-Peer Chat starten
def start_p2p_chat(target_ip, target_port, message):
    try:
        udp_socket.sendto(struct.pack('!B H', 8, target_port), (target_ip, target_port))
        print(f"Chat-Anfrage an {target_ip}:{target_port} gesendet.")
        
        peer_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        peer_socket.connect((target_ip, target_port))
        peer_socket.send(struct.pack('!B H', 9, len(message)) + message.encode('utf-8'))
        print("Nachricht gesendet.")
        peer_socket.close()
    except Exception as e:
        print(f"Fehler beim P2P-Chat: {e}")

def receive_messages():
    global running
    while running:
        try:
            msg_id = recv_with_timeout(tcp_socket, expected_length=1, timeout=2)
            if msg_id == 4:
                print("Neuer Client verbunden.")
                
                ip = recv_with_timeout(tcp_socket, expected_length=4, timeout=2)
                udp_port = recv_with_timeout(tcp_socket, expected_length=2, timeout=2)
                name_len = recv_with_timeout(tcp_socket, expected_length=1, timeout=2)
                name = recv_with_timeout(tcp_socket, expected_length=name_len, timeout=2)
                if name not in clients:
                    clients[name] = {'ip': ip, 'udp_port': udp_port}
                print(f"Neuer Client: {name}, IP: {ip}, UDP Port: {udp_port}")
                
            elif msg_id == 5:
                print("Client hat sich abgemeldet.")
                # Client abgemeldet, entferne ihn aus der Liste
                name_len = data[1]
                name = data[2:2+name_len].decode('utf-8')
                if name in clients:
                    del clients[name]
                print(f"Client {name} entfernt.")
            elif msg_id == 6:
                msg_len = struct.unpack('!H', data[1:3])[0]
                message = data[3:3+msg_len].decode('utf-8')
                print(f"Broadcast erhalten: {message}")
        except Exception as e:
            print(f"Fehler beim Empfangen von Nachrichten: {e}")



# Client-Liste anzeigen
def get_client_list():
    print("\nAktuelle Clients:")
    for name, info in clients.items():
        print(f"Name: {name}, IP: {info['ip']}, UDP Port: {info['udp_port']}")

# Disconnect vom Server
def disconnect_from_server():
    global running
    running = False
    try:
        tcp_socket.send(struct.pack('!B', 7))
        tcp_socket.close()
        print("Vom Server abgemeldet.")
    except Exception as e:
        print(f"Fehler beim Abmelden: {e}")

# Hauptprogramm
def main():
    parser = argparse.ArgumentParser(description='TCP/UDP Chat-Client')
    parser.add_argument('--host', type=str, default='127.0.0.1', help='Server-IP-Adresse (Standard: 127.0.0.1)')
    parser.add_argument('--tcp-port', type=int, default=7777, help='Server-TCP-Port (Standard: 7777)')
    parser.add_argument('--udp-port', type=int, default=8888, help='Lokaler UDP-Port (Standard: 8888)')
    args = parser.parse_args()

    SERVER_HOST = args.host
    SERVER_PORT = args.tcp_port
    UDP_PORT = args.udp_port

    # UDP-Port binden
    udp_socket.bind(('0.0.0.0', UDP_PORT))

    nickname = input("Gib deinen Nickname ein: ")
    register_with_server(nickname, SERVER_HOST, SERVER_PORT, UDP_PORT)
    
    receiver_thread = threading.Thread(target=receive_messages)
    receiver_thread.start()
    
    try:
        while running:
            print("\n1: Broadcast senden")
            print("2: Peer-to-Peer Chat starten")
            print("3: Client-Liste anzeigen")
            print("4: Disconnect")
            choice = input("Wähle eine Option: ")
            if choice == '1':
                message = input("Broadcast-Nachricht: ")
                send_broadcast(message)
            elif choice == '2':
                target_ip = input("IP des Ziel-Clients: ")
                target_port = int(input("Port des Ziel-Clients: "))
                message = input("Nachricht: ")
                start_p2p_chat(target_ip, target_port, message)
            elif choice == '3':
                get_client_list()
            elif choice == '4':
                disconnect_from_server()
                break
    except KeyboardInterrupt:
        disconnect_from_server()


if __name__ == '__main__':
    main()

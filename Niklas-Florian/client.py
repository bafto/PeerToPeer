import socket
import struct
import threading
import time

# Server-Verbindungsdaten
SERVER_HOST = '127.0.0.1'  # IP-Adresse des Servers
SERVER_PORT = 7777         # Port des Servers
UDP_PORT = 8888            # Lokaler UDP-Port

# Globale Variablen
running = True

# Socket für TCP und UDP erstellen
tcp_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp_socket.bind(('0.0.0.0', UDP_PORT))

# Registrierung beim Server
def register_with_server(nickname):
    try:
        tcp_socket.connect((SERVER_HOST, SERVER_PORT))
        print(f"Verbunden mit Server {SERVER_HOST}:{SERVER_PORT}")
        
        ip = socket.inet_aton(socket.gethostbyname(socket.gethostname()))
        msg = struct.pack('!B4sH B', 1, ip, UDP_PORT, len(nickname)) + nickname.encode('utf-8')
        tcp_socket.send(msg)
        
        response = tcp_socket.recv(1024)
        msg_id, num_clients = struct.unpack('!B I', response[:5])
        print(f"Erfolgreich registriert. {num_clients} andere Clients online.")
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

# Nachrichten empfangen (TCP & UDP)
def receive_messages():
    global running
    while running:
        try:
            data = tcp_socket.recv(1024)
            if not data:
                break
            msg_id = data[0]
            if msg_id == 4:
                print("Neuer Client verbunden.")
            elif msg_id == 5:
                print("Client hat sich abgemeldet.")
            elif msg_id == 6:
                msg_len = struct.unpack('!H', data[1:3])[0]
                message = data[3:3+msg_len].decode('utf-8')
                print(f"Broadcast erhalten: {message}")
        except Exception as e:
            print(f"Fehler beim Empfangen von Nachrichten: {e}")

# Disconnect vom Server
def disconnect_from_server():
    global running
    running = False
    try:
        tcp_socket.send(struct.pack('!B', 7))
        time.sleep(1)
        tcp_socket.close()
        print("Vom Server abgemeldet.")
    except Exception as e:
        print(f"Fehler beim Abmelden: {e}")

# Hauptprogramm
def main():
    nickname = input("Gib deinen Nickname ein: ")
    register_with_server(nickname)
    
    receiver_thread = threading.Thread(target=receive_messages)
    receiver_thread.start()
    
    try:
        while running:
            print("\n1: Broadcast senden")
            print("2: Peer-to-Peer Chat starten")
            print("3: Disconnect")
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
                disconnect_from_server()
                break
    except KeyboardInterrupt:
        disconnect_from_server()

if __name__ == '__main__':
    main()
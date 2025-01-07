import socket
import struct
import threading
import time
import argparse

# Globale Variablen
running = True
clients = {}  # Hier speichern wir die Client-Informationen als Dictionary

SERVER_HOST = None
UDP_PORT = None
TCP_PORT = None
IP = "0.0.0.0"
current_P2P_partner_name = None


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

def receive_messages_server():
    global running
    while running:
        try:
            msg_id = recv_with_timeout(tcp_socket_server, expected_length=1, timeout=2)
            
            if msg_id is None or len(msg_id) == 0:
                print("Keine gültige Nachricht empfangen.")
                continue

            # Konvertiere msg_id korrekt zu einem Integer
            msg_id_int = msg_id[0]
            print(f"Empfangene msg_id: {msg_id_int}")

            if msg_id_int == 4:
                ip = recv_with_timeout(tcp_socket_server, expected_length=4, timeout=2)
                ip = socket.inet_ntoa(ip)  

                udp_port = recv_with_timeout(tcp_socket_server, expected_length=2, timeout=2)
                udp_port = struct.unpack('!H', udp_port)[0]  
                
                # Namenslänge empfangen und dekodieren
                name_len = recv_with_timeout(tcp_socket_server, expected_length=1, timeout=2)
                name_len = name_len[0] 
                
                name = recv_with_timeout(tcp_socket_server, expected_length=name_len, timeout=2)
                name = name.decode('utf-8')  # Dekodiere Bytes zu String
                
                # Daten im Client-Array speichern
                clients[name] = {'ip': ip, 'udp_port': udp_port}
                print(f"Neuer Client: {name}, IP: {ip}, UDP Port: {udp_port}")
            elif msg_id_int == 5:
                name_len = recv_with_timeout(tcp_socket_server, expected_length=1, timeout=2)[0] 

                name = recv_with_timeout(tcp_socket_server, expected_length=name_len, timeout=2).decode('utf-8')

                if name in clients:
                    del clients[name]
                    print(f"Client {name} entfernt.")
                else:
                    print(f"Client {name} nicht in der Liste gefunden.")

            
            elif msg_id_int == 6:
                msg_len = recv_with_timeout(tcp_socket_server, expected_length=2, timeout=2)
                if msg_len:
                    msg_len = int.from_bytes(msg_len, 'big')  # Konvertiere 2 Bytes zu Integer
                    message = recv_with_timeout(tcp_socket_server, expected_length=msg_len, timeout=2).decode('utf-8') 
                    print(f"Broadcast erhalten: {message}")
                    
        except Exception as e:
            print(f"Fehler beim Empfangen von Nachrichten: {e}")


# Registrierung beim Server
def register_with_server(nickname, server_host, server_port, udp_port):
    try:
        tcp_socket_server.connect((server_host, server_port))
        print(f"Verbunden mit Server {server_host}:{server_port}")
        
        ip = socket.inet_aton(socket.gethostbyname(socket.gethostname()))
        msg = struct.pack('!B4sH B', 1, ip, udp_port, len(nickname)) + nickname.encode('utf-8')
        tcp_socket_server.send(msg)
        
        response = tcp_socket_server.recv(1024)
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
        tcp_socket_server.close()

# Client-Liste anzeigen
def get_client_list():
    print("\nAktuelle Clients:")
    for name, info in clients.items():
        print(f"Name: {name}, IP: {info['ip']}, UDP Port: {info['udp_port']}")


# Broadcast senden
def send_broadcast(message):
    try:
        message = message.encode('utf-8')
        msg = struct.pack('!B H', 6, len(message)) + message
        tcp_socket_server.send(msg)
        print("Broadcast gesendet.")
    except Exception as e:
        print(f"Fehler beim Broadcast: {e}")

# Disconnect vom Server
def disconnect_from_server():
    global running
    running = False
    try:
        tcp_socket_server.send(struct.pack('!B', 7))
        tcp_socket_server.close()
        print("Vom Server abgemeldet.")
    except Exception as e:
        print(f"Fehler beim Abmelden: {e}")

# P2P -----------------------------------

# P2P -----------------------------------

# Sockets für TCP und UDP erstellen
tcp_socket_server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
udp_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
tcp_socket_P2P = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

def main():
    parser = argparse.ArgumentParser(description='TCP/UDP Chat-Client')
    parser.add_argument('--host', type=str, default='127.0.0.1', help='Server-IP-Adresse (Standard: 127.0.0.1)')
    parser.add_argument('--tcp-port', type=int, default=7777, help='Server-TCP-Port (Standard: 7777)')
    parser.add_argument('--udp-port', type=int, default=8888, help='Lokaler UDP-Port (Standard: 8888)')
    args = parser.parse_args()

    global SERVER_HOST, UDP_PORT, TCP_PORT
    SERVER_HOST = args.host
    UDP_PORT = args.udp_port
    TCP_PORT = args.tcp_port

    # UDP-Port binden
    udp_socket.bind((IP, UDP_PORT))

    nickname = input("Gib deinen Nickname ein: ")
    register_with_server(nickname, SERVER_HOST, 7777, UDP_PORT)

    receiver_thread = threading.Thread(target=receive_messages_server)
    receiver_thread.start()

    

    try:
        while running:
            print("\n1: Broadcast senden")
            print("2: Peer-to-Peer Chat starten")
            print("3: Client-Liste anzeigen")
            print("5: Aktuellen P2P-Partner anzeigen")
            print("6: Nachricht über P2P senden")
            print("7: Disconnect")
            choice = input("Wähle eine Option: ")

            if choice == '1':
                message = input("Broadcast-Nachricht: ")
                send_broadcast(message)
            elif choice == '2':
                target_name = input("Name des Ziel-Clients: ")
                #start_P2P_chat(target_name)
            elif choice == '3':
                get_client_list()
            elif choice == '5':
                if current_P2P_partner_name:
                    print(f"Aktueller P2P-Partner: {current_P2P_partner_name}")
                else:
                    print("Kein P2P-Partner verbunden.")
            elif choice == '6':
                # Nachricht über P2P senden
                if current_P2P_partner_name:
                    message = input("Nachricht an Peer: ")
                    msg_data = struct.pack('!H', len(message)) + message.encode('utf-8')
                    tcp_socket_P2P.send(msg_data)
                    print(f"Nachricht an Peer gesendet.")
                else:
                    print("Kein aktiver P2P-Partner. Verbindungsaufbau erforderlich.")
            elif choice == '7':
                disconnect_from_server()
                break
    except KeyboardInterrupt:
        disconnect_from_server()

if __name__ == '__main__':
    main()
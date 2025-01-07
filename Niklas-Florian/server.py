import socket
import threading
import struct
import argparse
import time

SERVER_HOST = '127.0.0.1'
SERVER_PORT = 7777

clients = {}  # Speichert die Verbindungen der Clients

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

def handle_client(client_socket):
    try:
        while True:
            if handel_msg(client_socket) != None:
                break
    except Exception as e:
        print(f"Error handling client: {e}")
        for name, (sock, _, _) in list(clients.items()):
            if sock == client_socket:
                del clients[name]
                print(f"Client {name} wurde entfernt.")
                handel_disconnected_notification(name)
                break
        client_socket.close()
        
        

def handel_msg(client_socket):
    # liest die msg-ID
    msg_id = recv_with_timeout(client_socket, expected_length=1, timeout=5)
    handler = MSG_HANDLERS_Server.get(msg_id[0])
    if handler:
        return handler(client_socket)
    else:
        print(f"Kein Handler für msg_id {msg_id} gefunden!")


def handel_fehler(client_socket):  # Msg-Id: 0
    error_code = recv_with_timeout(client_socket, expected_length=1, timeout=5)
    print(f"Fehler behandeln - Code: {error_code}")


def handel_registrierung(client_socket):  # Msg-Id: 1
    try:
        data = recv_with_timeout(client_socket, expected_length=7, timeout=5)
        ip, udp_port, name_len = struct.unpack('!4sH B', data)
        data = recv_with_timeout(client_socket, name_len, 5)
        name = data.decode('utf-8')

        if name in clients:
            client_socket.send(struct.pack('!BB', 0, 2))  # Fehler: Nickname nicht unique
            return

        clients[name] = (client_socket, socket.inet_ntoa(ip), udp_port)  
        print(f"Neuer Client registriert: {name}, IP: {socket.inet_ntoa(ip)}, UDP Port: {udp_port}")

        handel_registrierung_response(client_socket)
        handel_neuer_client_connected(client_socket, name, socket.inet_ntoa(ip), udp_port)

    except Exception as e:
        print(f"Registrierungsfehler: {e}")



def handel_registrierung_response(client_socket):  # Msg-Id: 2
    client_list = b''
    for nick, (sock, ip, port) in clients.items():
        client_list += struct.pack('!4sH B', socket.inet_aton(ip), port, len(nick)) + nick.encode('utf-8')

    response = struct.pack('!B I', 2, len(clients)) + client_list
    client_socket.send(response)
    print(f"Registrierungsantwort gesendet: {len(clients)} Clients")



def handel_neuer_client_connected(client_socket, new_client_name, new_client_ip, new_client_port):  # Msg-Id: 4
    for client_name, (sock, client_ip, client_port) in clients.items():
        if sock != client_socket:  # Nachricht nicht an den neuen Client senden
            try:
                name_encoded = new_client_name.encode('utf-8')
                name_len = len(name_encoded)
                print("namelen: ", name_len)

                ip_as_int = struct.unpack('!I', socket.inet_aton(new_client_ip))[0]  # Wandelt die IP in einen Integer um

                msg = struct.pack('!I H B', ip_as_int, new_client_port, name_len) + name_encoded

                response = struct.pack('!B', 4) + msg
                sock.send(response)
            except Exception as e:
                print(f"Fehler beim Senden der Benachrichtigung an {client_name}: {e}")


def handel_disconnected_notification(disconnected_client_name):  # Msg-Id: 5
    print(f"Client {disconnected_client_name} hat sich disconnected.")

    for client_name, (sock, client_ip, client_port) in clients.items():
        try:
            message = struct.pack('!B B', 5, len(disconnected_client_name)) + disconnected_client_name.encode('utf-8')
            sock.send(message)
            print(f"Benachrichtigung an {client_name}, dass {disconnected_client_name} sich disconnected hat.")
        except Exception as e:
            print(f"Fehler beim Senden der Disconnect-Nachricht an {client_name}: {e}")



def handel_broadcast(client_socket):  # Msg-Id: 6
    try:
        msg_len_data = recv_with_timeout(client_socket, expected_length=2, timeout=2)
        if not msg_len_data:  
            print("Keine Daten für Nachrichtengröße empfangen.")
            return
        
        msg_len = struct.unpack('!H', msg_len_data)[0]  
        
        msg = recv_with_timeout(client_socket, expected_length=msg_len, timeout=2)
        if not msg:  
            print("Keine Nachricht empfangen.")
            return

        print("Broadcast Nachricht empfangen:", msg.decode('utf-8'))

        # Broadcast an alle anderen Clients senden
        for client_name, (sock, client_ip, client_port) in clients.items():
            if sock != client_socket:  # Nachricht nicht an den Sender selbst senden
                try:
                    response = struct.pack('!B H', 6, len(msg)) + msg 
                    sock.send(response)  
                    print(f"Nachricht an {client_name} gesendet: {msg.decode('utf-8')}")
                except Exception as e:
                    print(f"Fehler beim Senden der Broadcast-Nachricht an {client_name}: {e}")
    except Exception as e:
        print(f"Fehler beim Bearbeiten der Broadcast-Nachricht: {e}")



def handel_disconnect_message(client_socket):  # Msg-Id: 7
    disconnected_client_name = None

    for name, (sock, ip, port) in list(clients.items()):
        if sock == client_socket:
            disconnected_client_name = name
            del clients[name]
            client_socket.close()
            break
    if disconnected_client_name:
        handel_disconnected_notification(disconnected_client_name)
    return True




MSG_HANDLERS_Server = {
    0: handel_fehler,
    1: handel_registrierung,
    6: handel_broadcast,
    7: handel_disconnect_message,
}


def main():
    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_socket.bind((SERVER_HOST, SERVER_PORT))
    server_socket.listen(5)
    server_socket.settimeout(1.0)  # Timeout von 1 Sekunde setzen
    print(f"Server listening on {SERVER_HOST}:{SERVER_PORT}")

    try:
        while True:
            try:
                client_socket, client_address = server_socket.accept()
                threading.Thread(target=handle_client, args=(client_socket,)).start()
            except socket.timeout:
                continue  # Timeout erreicht, weiter zur nächsten Iteration
    except KeyboardInterrupt:
        print("\nServer wird heruntergefahren...")
    finally:
        server_socket.close()

if __name__ == "__main__":
    main()



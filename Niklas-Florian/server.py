import socket
import threading
import struct

SERVER_HOST = '0.0.0.0'
SERVER_PORT = 7777

clients = {}  # Speichert die Verbindungen der Clients


def handle_client(client_socket):
    while True:
        try:
            handel_msg(client_socket)
        except Exception as e:
            print(f"Error handling client: {e}")
        finally:
            client_socket.close()


def handel_msg(client_socket):
    data = client_socket.recv(1024)
    msg_id = data[0]
    handler = MSG_HANDLERS_Server.get(msg_id)
    if handler:
        handler(data, client_socket)
    else:
        print(f"Kein Handler für msg_id {msg_id} gefunden!")


def handel_fehler(data, client_socket):  # Msg-Id: 0
    error_code = data[1]
    print(f"Fehler behandeln - Code: {error_code}")


def handel_registrierung(data, client_socket):  # Msg-Id: 1
    try:
        ip, udp_port, name_len = struct.unpack('!4sH B', data[1:8])
        name = data[8:8 + name_len].decode('utf-8')

        if name in clients:
            client_socket.send(struct.pack('!BB', 0, 2))  # Fehler: Nickname nicht unique
            return

        clients[name] = (socket.inet_ntoa(ip), udp_port)  
        print(f"Neuer Client registriert: {name}, IP: {socket.inet_ntoa(ip)}, UDP Port: {udp_port}")

        handel_registrierung_response(client_socket)

        handel_neuer_client_connected(client_socket, name, socket.inet_ntoa(ip), udp_port)

    except Exception as e:
        print(f"Registrierungsfehler: {e}")


def handel_registrierung_response(client_socket):  # Msg-Id: 2
    client_list = b''
    for nick, (ip, port) in clients.items():
        client_list += struct.pack('!4sH B', socket.inet_aton(ip), port, len(nick)) + nick.encode('utf-8')

    response = struct.pack('!B I', 2, len(clients)) + client_list
    client_socket.send(response)
    print(f"Registrierungsantwort gesendet: {len(clients)} Clients")


def handel_neuer_client_connected(client_socket, new_client_name, new_client_ip, new_client_port):  # Msg-Id: 4
    for client_name, (client_ip, client_port) in clients.items():
        # Sende Nachricht an alle Clients, die nicht der neu verbundene Client sind
        if client_socket.getpeername() != (client_ip, client_port):
            try:
                msg = f"Neuer Client verbunden: {new_client_name}, IP: {new_client_ip}, Port: {new_client_port}"
                response = struct.pack('!B H', 4, len(msg)) + msg.encode('utf-8')

                client_socket_item = [sock for sock, _ in clients.items() if sock.getpeername() == (client_ip, client_port)]
                
                if client_socket_item:
                    client_socket_item[0].send(response)

                print(f"Nachricht an {client_name} gesendet: {msg}")
            except Exception as e:
                print(f"Fehler beim Senden der Benachrichtigung an {client_name}: {e}")



def handel_disconnected_notification(data, client_socket):  # Msg-Id: 5
    disconnected_client_name = data[1:].decode('utf-8')  # Name des disconnecteten Clients aus den Daten
    print(f"Client {disconnected_client_name} hat sich disconnected.")

    for client_name, (client_ip, client_port) in clients.items():
        if client_socket.getpeername() != (client_ip, client_port):  # Den Client, der sich disconnected hat, überspringen
            print(f"Benachrichtigung an {client_name}, dass {disconnected_client_name} sich disconnected hat.")
            message = struct.pack('!B B', 5, len(disconnected_client_name)) + disconnected_client_name.encode('utf-8')
            client_socket.send(message)  # Hier 'send' statt 'sendto', da wir TCP verwenden


def handel_broadcast(data, client_socket):  # Msg-Id: 6
    try:
        msg_len = struct.unpack('!H', data[1:3])[0]
        msg = data[3:3 + msg_len].decode('utf-8')

        for client_name, (client_ip, client_port) in clients.items():
            if client_socket.getpeername() != (client_ip, client_port):
                try:
                    response = struct.pack('!B H', 6, len(msg)) + msg.encode('utf-8')
                    client_socket.send(response)  # TCP senden
                    print(f"Nachricht an {client_name} gesendet: {msg}")
                except Exception as e:
                    print(f"Fehler beim Senden der Broadcast-Nachricht an {client_name}: {e}")
    except Exception as e:
        print(f"Fehler beim Bearbeiten der Broadcast-Nachricht: {e}")


def handel_disconnect_message(data, client_socket):  # Msg-Id: 7
    for name, (ip, port) in clients.items():
        if client_socket.getpeername() == (ip, port):
            del clients[name]
            print(f"Client {name} hat sich disconnected.")
            break

    handel_disconnected_notification(client_socket)


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
    print(f"Server listening on {SERVER_HOST}:{SERVER_PORT}")

    while True:
        client_socket, client_address = server_socket.accept()
        threading.Thread(target=handle_client, args=(client_socket,)).start()


if __name__ == "__main__":
    main()

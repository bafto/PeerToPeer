# Chat

Gruppenmitglieder: Hendrik Ziegler, Leon Gies, Arthur Zeidler, Florian Hauser, Niklass Schaffran, Samuel Tim

## Allgemein

### Message IDs
- 0: Error
- 1: Registrierung
- 2: Registrierung Antwort
- 4: Neuer Client Connected
- 5: Client Disconnected Notification
- 6: Broadcast
- 7: Client Disconnect Message
- 8: Peer-To-Peer Chat Anfrage
- 9: Peer-To-Peer Nachricht

## Error Message

- 1 Byte Msg-ID (0 für Error)
- 1 Byte Error-Code

### Error Codes (EC)

- 0: Unbekannte Msg-ID
- 1: (IP, Port) nicht unique
- 2: Nickname nicht unique
- 3: Textlänge ist null
- 4: Text nicht UTF-8
- 5: Client Liste invalid

```C
struct ErrorMessage {
    uint8_t msg_id; // 0
    uint8_t error_code;
}
```

## Messages
### Registrierung beim Server (Clientside, ID: 1)
Client verbindet sich zum Server via TCP auf Port 7777
  - 1 Byte Msg-ID (1 für Registrieren)
  - 4 Byte IP (EC: 1)
  - 2 Byte UDP Port (EC: 1)
  - 1 Byte Länge des Nickname in Byte (N) (EC: 3)
  - N Byte UTF-8 Name (Timeout 3 Sekunden) (EC: 2, 4)

```C
struct ClientInfo {
    uint32_t client_ip;
    uint16_t client_udp_port;
    uint8_t name_len; // N
    uint8_t name[N]; // utf-8
};

struct RegistrationRequest {
    uint8_t msg_id; // 1
    struct ClientInfo client_info;
}
```

### Registrierung Antwort (Serverside, ID: 2)
Server Antwort mit der momentanen Client Liste
  - 1 Byte Msg-ID (2 für Registrierung erfolgreich)
  - 4 Byte Anzahl Clients (M)
  - M Mal:
      - 4 Byte IP
      - 2 Byte UDP Port
      - 1 Byte Länge des Nickname mit Wert N (EC: 3)
      - N Byte UTF-8 Name (EC: 2, 4)

```C
struct RegistrationResponse {
    uint8_t msg_id; // 2
    uint32_t n_clients; // M
    struct ClientInfo clients[M];
}
```

### Neuer Client Connected (Serverside, ID: 4)
Der Server schickt jedem anderem Client eine NewClientConnected Message wenn sich ein Client zum Server verbindet.
- 1 Byte Message ID (4)
- ClientInfo


```C
struct NewClientConnected {
    uint8_t msg_id; // 4
    struct ClientInfo client_info;
}
```

### Client Disconnected (Serverside, ID: 5)
Der Server schickt jedem anderem Client eine ClientDisconnected Message wenn die Verbindung zum Server beendet wird.

- 1 Byte Message ID (5)
- 1 Byte Namenslänge N (EC: 3)
- N Byte UTF-8 Name (EC: 2, 4)

```C
struct ClientDisconnected {
    uint8_t msg_id; // 5
    uint8_t name_len; // N
    uint8_t name[N]; // utf-8
}
```

## Broadcast (Client+Server-side, ID: 6)
Ein Client schickt eine Broadcast Message an den Server. Der Server schickt daraufhin eine Broadcast Message an alle Clients. Timeout 5 Sekunden

- 1 Byte Message ID (6)
- 2 Byte Nachrichtlänge N (EC: 3)
- N Byte Nachricht (EC: 4)

```C
struct BroadcastMessage {
    uint8_t msg_id; // 6
    uint16_t msg_len; // N
    uint8_t msg[N]; // utf-8
}
```

## Client Disconnect (Clientside, ID: 7)
Client schickt dem Server eine Client Disconnect Message, wenn er sich Disconnecten will
```C
struct DisconnectMessage {
    uint8_t msg_id; // 7
}
```

## Peer-To-Peer

### Chat Anfrage (UDP, Client zu Client, ID: 8)
Client schickt dem Kommunikationspartner eine Chat Anfrage.
- 1 Byte Message ID
- 4 Byte TCP Port
- 1 Byte Namenslänge N (EC: 3)
- N Byte Name (EC: 4)

- 3 Retries im Abstand von 2 Sekunden

```C
struct PeerToPeerRequest {
    uint8_t msg_id; // 8
    uint16_t tcp_port;
	uint8_t name_len; // N
    uint8_t name[N]; // utf-8
}
```

### Peer-To-Peer Message (TCP, Client zu Client, ID: 9)
Client schickt seinem Kommunikationspartner eine Nachricht
- 1 Byte Message ID
- 2 Byte Nachrichtlänge N (EC: 3)
- N Byte Nachricht (EC: 4)

```C
struct PeerToPeerMessage {
    uint8_t msg_id; // 9
    uint16_t msg_len; // N
    uint8_t msg[N]; // utf-8
}
```

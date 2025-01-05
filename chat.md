# Chat

## Allgemein

### Message IDs
- 0: Fehler
- 1: Registrierung
- 3: Client Liste Erhalten
- 4: Neuer Client connected
- 5: Client Disconnected Notification
- 6: Broadcast
- 7: Client Disconnect Message
- 8: Peer-To-Peer Chat Anfrage
- 9: Peer-To-Peer Nachricht

## Error Message

- 1 Byte Msg-ID (0 für Error)
- 1 Byte Error-Code

### Error Codes (FC)

- 0: Unbekannte Msg-ID
- 1: (IP, Port) nicht unique
- 2: Nickname nicht unique
- 3: Länge vom Nickname > 0
- 4: Name invalid UTF-8
- 5: Client Liste invalid

```C
struct ErrorMessage {
    uint8_t msg_id; // 0
    uint8_t error_code;
}
```

## Registrierung beim Server (ID: 1,2)

- Client verbindet sich zum Server via TCP auf Port 7777
    - 1 Byte Msg-ID (1 für Registrieren)
    - 4 Byte IP (FC: 1)
    - 2 Byte UDP Port (FC: 1)
    - 1 Byte Länge des Nickname in Byte (N) ; Länge > 0, Unique (FC: 3)
    - N Byte Name (wie in vorheriger Länge angegeben, UTF-8) (Timeout 3 Sekunden) (FC: 2, 4)

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

- Server Antwort mit der momentanen Client Liste
    - 1 Byte Msg-ID (2 für Registrierung erfolgreich)
    - 4 Byte Anzahl Clients (M)
    - M Mal:
        - 4 Byte IP
        - 2 Byte UDP Port
        - 1 Byte Länge des Nickname mit Wert N ; Länge > 0, Unique
        - N Byte Name (wie in vorheriger Länge angegeben)

```C
struct RegistrationResponse {
    uint8_t msg_id; // 2
    uint32_t n_clients; // M
    struct ClientInfo clients[M];
}
```

## Client Listen Updates 

### Neuer Client (ID: 4)

```C
struct NewClientConnected {
    uint8_t msg_id; // 4
    struct ClientInfo client_info;
}
```

### Client Disconnected (Server zu Client, ID: 5)

```C
struct ClientDisconnected {
    uint8_t msg_id; // 5
    uint8_t name_len; // N
    uint8_t name[N]; // utf-8
}
```

## Broadcast (ID: 6)

Timeout 5 Sekunden
Ein Client schickt eine Broadcast Message an den Server. Der Server schickt daraufhin eine Broadcast Message an alle Clients.


```C
struct BroadcastMessage {
    uint8_t msg_id; // 6
    uint16_t msg_len; // N
    uint8_t msg[N]; // utf-8
}
```


## Client Disconnect (Client zu Server, ID: 7)

```C
struct DisconnectMessage {
    uint8_t msg_id; // 7
}
```

## Peer-To-Peer

### Chat Anfrage (via UDP von Client zu Client, ID: 8)

- 3 Retries im Abstand von 2 Sekunden

```C
struct PeerToPeerRequest {
    uint8_t msg_id; // 8
    uint16_t tcp_port;
}
```

### Peer-To-Peer Message (ID: 9)

```C
struct PeerToPeerMessage {
    uint8_t msg_id; // 9
    uint16_t msg_len; // N
    uint8_t msg[N]; // utf-8
}
```

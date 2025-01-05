# constants.py


MESSAGE_TYPES = (
    (0, "Fehler"),
    (1, "Registrierung"),
    (2, "Registrierungs Antwort (Client Liste)"),
    (4, "Neuer Client connected"),
    (5, "Client Disconnected Notification"),
    (6, "Broadcast"),
    (7, "Client Disconnect Message"),
    (8, "Peer-To-Peer Chat Anfrage"),
    (9, "Peer-To-Peer Nachricht")
)

ERROR_CODES = (
    (0, "Unbekannte Msg-ID"),
    (1, "(IP, Port) nicht unique"),
    (2, "Nickname nicht unique"),
    (3, "Länge vom Nickname > 0"),
    (4, "Name invalid UTF-8"),
    (5, "Client Liste invalid")
)

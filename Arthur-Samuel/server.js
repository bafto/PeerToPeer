#!/usr/bin/env node

/**
 * Server für den Gruppenchat.
 *
 * Protokoll gemäß der Aufgabenstellung:
 * TCP-Port: 7777
 * Nachrichtentypen (Msg-IDs):
 *   0: Error
 *   1: Registrierung (Client->Server)
 *   2: Registrierung Antwort (Server->Client)
 *   4: Neuer Client Connected (Server->Clients)
 *   5: Client Disconnected Notification (Server->Clients)
 *   6: Broadcast (Client->Server oder Server->Clients)
 *   7: Client Disconnect (Client->Server)
 *
 * Für das P2P (UDP):
 *   8: P2P Chat Anfrage (UDP)
 *   9: P2P Nachricht (UDP)
 */

const net = require('net');
const readline = require('readline');

/**
 * Clients, die am Server registriert sind.
 * Array von Objekten mit:
 *   {
 *     name: string,
 *     ip: number,     // 4-Byte IPv4 im Integer-Format
 *     udpPort: number,
 *     socket: net.Socket
 *   }
 */
let clients = [];

// TCP-Server-Port laut Aufgabenstellung
const SERVER_TCP_PORT = 7777;

/**
 * Hilfsfunktionen zum Konvertieren:
 *   - IP (string) <-> number (uint32)
 */
function ipToUint32(ipStr) {
  const parts = ipStr.split('.').map(p => parseInt(p, 10));
  return ((parts[0] << 24) >>> 0)
       + ((parts[1] << 16) >>> 0)
       + ((parts[2] << 8)  >>> 0)
       +  (parts[3]       >>> 0);
}

function uint32ToIp(num) {
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff
  ].join('.');
}

/**
 * Für Fehlermeldungen eine kleine Decode-Funktion (nur zum Loggen).
 */
function decodeErrorCode(code) {
  switch (code) {
    case 0: return "Unbekannte Msg-ID";
    case 1: return "(IP, Port) nicht unique";
    case 2: return "Nickname nicht unique";
    case 3: return "Textlänge ist 0";
    case 4: return "Text nicht UTF-8";
    case 5: return "Clientliste invalid";
    default: return "Unbekannter Error Code";
  }
}

/**
 * Baut eine Error-Message als Buffer:
 * Msg-ID (1 Byte = 0)
 * Error-Code (1 Byte)
 */
function buildErrorMessage(errorCode) {
  console.log(`Sende Error-Code=${errorCode} (${decodeErrorCode(errorCode)}) an Client.`);
  const buf = Buffer.alloc(2);
  buf.writeUInt8(0, 0);        // Msg-ID = 0
  buf.writeUInt8(errorCode, 1);
  return buf;
}

/**
 * Baut die Registrierungs-Antwort (ID=2).
 * Struktur:
 * 1 Byte: Msg-ID = 2
 * 4 Byte: Anzahl Clients = M
 * Dann M Einträge à:
 *   4 Byte IP
 *   2 Byte UDP-Port
 *   1 Byte Name-Länge
 *   N Byte Name (UTF-8)
 */
function buildRegistrationResponse(clientList) {
  let totalLength = 1 + 4; // Msg-ID + Anzahl
  for (const c of clientList) {
    totalLength += 4 + 2 + 1 + Buffer.byteLength(c.name, 'utf8');
  }
  const buf = Buffer.alloc(totalLength);

  let offset = 0;
  buf.writeUInt8(2, offset); // Msg-ID = 2
  offset += 1;

  buf.writeUInt32BE(clientList.length, offset);
  offset += 4;

  for (const c of clientList) {
    buf.writeUInt32BE(c.ip, offset);       // IP
    offset += 4;
    buf.writeUInt16BE(c.udpPort, offset);  // UDP-Port
    offset += 2;
    const nameBuf = Buffer.from(c.name, 'utf8');
    buf.writeUInt8(nameBuf.length, offset); // Name-Länge
    offset += 1;
    nameBuf.copy(buf, offset);
    offset += nameBuf.length;
  }

  return buf;
}

/**
 * Baut die "Neuer Client Connected" (ID=4) Nachricht.
 * Struktur:
 * 1 Byte: Msg-ID = 4
 * 4 Byte: IP
 * 2 Byte: UDP-Port
 * 1 Byte: Name-Länge
 * N Byte: Name
 */
function buildNewClientConnected(client) {
  const nameBuf = Buffer.from(client.name, 'utf8');
  const totalLength = 1 + 4 + 2 + 1 + nameBuf.length;
  const buf = Buffer.alloc(totalLength);
  let offset = 0;

  buf.writeUInt8(4, offset); // Msg-ID = 4
  offset += 1;
  buf.writeUInt32BE(client.ip, offset);
  offset += 4;
  buf.writeUInt16BE(client.udpPort, offset);
  offset += 2;
  buf.writeUInt8(nameBuf.length, offset);
  offset += 1;
  nameBuf.copy(buf, offset);
  offset += nameBuf.length;

  return buf;
}

/**
 * Baut die "Client Disconnected" (ID=5) Nachricht.
 * Struktur:
 * 1 Byte: Msg-ID=5
 * 1 Byte: Name-Länge
 * N Byte: Name
 */
function buildClientDisconnected(name) {
  const nameBuf = Buffer.from(name, 'utf8');
  const totalLength = 1 + 1 + nameBuf.length;
  const buf = Buffer.alloc(totalLength);

  let offset = 0;
  buf.writeUInt8(5, offset); // 5
  offset += 1;
  buf.writeUInt8(nameBuf.length, offset);
  offset += 1;
  nameBuf.copy(buf, offset);

  return buf;
}

/**
 * Baut eine Broadcast-Nachricht (ID=6).
 * Struktur:
 * 1 Byte: Msg-ID=6
 * 4 Byte: Nachrichtenlänge N
 * N Byte: UTF-8 Nachricht
 */
function buildBroadcastMessage(text) {
  const textBuf = Buffer.from(text, 'utf8');
  const totalLength = 1 + 2 + textBuf.length;
  const buf = Buffer.alloc(totalLength);

  let offset = 0;
  buf.writeUInt8(6, offset); // Msg-ID=6
  offset += 1;
  buf.writeUInt16BE(textBuf.length, offset);
  offset += 2;
  textBuf.copy(buf, offset);

  return buf;
}

/**
 * Sendet an alle aktiven Clients die gegebene Nachricht (Buffer).
 * Optional kann man `exceptSocket` angeben, dann wird an diesen Socket
 * nicht gesendet.
 */
function broadcast(buffer, exceptSocket = null) {
  for (const c of clients) {
    if (c.socket !== exceptSocket) {
      c.socket.write(buffer);
    }
  }
}

/**
 * Handhabt eingehende Daten auf einer neu verbundenen TCP-Verbindung.
 */
function handleData(socket, data) {
  // Achtung: In einer realen Implementierung müssten wir hier
  // evtl. "puffern", wenn mehrere Nachrichten in data stecken usw.
  const msgId = data.readUInt8(0);

  switch (msgId) {
    case 1: {
      // Registrierung
      // 1 Byte Msg-ID
      // 4 Byte IP
      // 2 Byte UDP-Port
      // 1 Byte Name-Länge
      // N Byte Name
      if (data.length < 1 + 4 + 2 + 1) {
        socket.write(buildErrorMessage(0)); // Unbekannte oder fehlerhafte Nachricht
        return;
      }

      let offset = 1;
      const ip = data.readUInt32BE(offset);
      offset += 4;
      const udpPort = data.readUInt16BE(offset);
      offset += 2;
      const nameLen = data.readUInt8(offset);
      offset += 1;

      if (nameLen === 0) {
        socket.write(buildErrorMessage(3)); // Textlänge = 0
        return;
      }
      if (offset + nameLen > data.length) {
        socket.write(buildErrorMessage(0)); // kaputte Nachricht
        return;
      }

      const nameBuf = data.slice(offset, offset + nameLen);
      const name = nameBuf.toString('utf8');

      // Prüfen, ob IP+Port unique oder Name unique
      if (clients.find(c => c.ip === ip && c.udpPort === udpPort)) {
        socket.write(buildErrorMessage(1)); // (IP,Port) nicht unique
        return;
      }
      if (clients.find(c => c.name === name)) {
        socket.write(buildErrorMessage(2)); // Nickname nicht unique
        return;
      }

      // Alles okay -> client eintragen
      const newClient = {
        ip,
        udpPort,
        name,
        socket
      };
      clients.push(newClient);

      // RegistrierungAntwort (ID=2) mit der aktuellen Clientliste
      const regResp = buildRegistrationResponse(clients);
      socket.write(regResp);

      // An andere: Neuer Client (ID=4)
      const newConnMsg = buildNewClientConnected(newClient);
      broadcast(newConnMsg, socket);

      console.log(`Client '${name}' eingeloggt. IP=${uint32ToIp(ip)} UDP=${udpPort}`);
      break;
    }

    case 6: {
      // Broadcast vom Client
      // 1 Byte Msg-ID
      // 4 Byte msgLen
      // N Byte UTF-8
      if (data.length < 1 + 4) {
        socket.write(buildErrorMessage(0));
        return;
      }
      let offset = 1;
      const msgLen = data.readUInt32BE(offset);
      offset += 4;
      if (msgLen === 0) {
        socket.write(buildErrorMessage(3)); // leere Nachricht
        return;
      }
      if (offset + msgLen > data.length) {
        socket.write(buildErrorMessage(0)); // defekte Nachricht
        return;
      }
      const msgBuf = data.slice(offset, offset + msgLen);
      const msgText = msgBuf.toString('utf8');

      // Als Server an alle verteilen
      const broadcastBuf = buildBroadcastMessage(msgText);
      broadcast(broadcastBuf);

      console.log(`Broadcast von einem Client: ${msgText}`);
      break;
    }

    case 7: {
      // Client Disconnect
      // 1 Byte Msg-ID = 7
      // => Wir entfernen den Client aus der Liste und schicken ID=5 an alle
      const c = clients.find(cl => cl.socket === socket);
      if (c) {
        const discMsg = buildClientDisconnected(c.name);
        broadcast(discMsg, socket);

        console.log(`Client '${c.name}' disconnected`);
        clients = clients.filter(x => x.socket !== socket);
      }
      socket.end(); // Verbindung schließen
      break;
    }

    default: {
      // Unbekannter Msg-ID
      socket.write(buildErrorMessage(0));
      break;
    }
  }
}

/**
 * TCP-Server starten
 */
const server = net.createServer((socket) => {
  socket.on('data', (data) => {
    handleData(socket, data);
  });

  socket.on('error', (err) => {
    console.error('Socket-Fehler:', err.message);
  });

  socket.on('close', () => {
    // Falls der Client "abrupt" beendet hat:
    const c = clients.find(cl => cl.socket === socket);
    if (c) {
      const discMsg = buildClientDisconnected(c.name);
      broadcast(discMsg, socket);
      console.log(`Client '${c.name}' connection closed`);
      clients = clients.filter(x => x.socket !== socket);
    }
  });
});

server.listen(SERVER_TCP_PORT, () => {
  console.log(`Group Chat Server läuft auf TCP-Port ${SERVER_TCP_PORT}.`);
});

/**
 * Minimales TUI für den Server (nur einfache Kommandos).
 */
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('Server TUI-Kommandos:');
console.log('  /list    - Zeigt aktuelle Clients an');
console.log('  /exit    - Server beenden');

rl.on('line', (line) => {
  const cmd = line.trim();
  switch (cmd) {
    case '/list':
      console.log('Aktuelle Clients:');
      clients.forEach((c, idx) => {
        console.log(
          `  ${idx + 1}. ${c.name} [${uint32ToIp(c.ip)}:${c.udpPort}]`
        );
      });
      break;
    case '/exit':
      console.log('Server wird beendet...');
      server.close(() => {
        process.exit(0);
      });
      // Alle Sockets schließen
      for (const c of clients) {
        c.socket.destroy();
      }
      break;
    default:
      console.log('Unbekanntes Kommando.');
      break;
  }
});
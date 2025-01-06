#!/usr/bin/env node

/**
 * Gruppenchat-Client gemäß Byte-Struktur-Protokoll.
 *
 * Hauptfunktionen:
 *  - TCP zum Server (Registrierung, Broadcast, Disconnect).
 *  - **P2P-Logik** wie im Go-Beispiel:
 *    - Initiator:  Startet lokalen TCP-Server (Port=0 => ephemeral).
 *                  Schickt (ID=8) per UDP "Komm auf Port X" an Peer.
 *    - Empfänger:  Bekommt UDP (ID=8), baut TCP-Verbindung auf.
 *    - Beide tauschen ID=9-Nachrichten über diese TCP-Verbindung aus.
 *
 *  - Name-Mapping via IP (UDP-Absender <-> TCP-remoteAddress).
 */

const net = require('net');
const dgram = require('dgram');
const readline = require('readline');

/** Server-Port laut Aufgabenstellung */
const SERVER_TCP_PORT = 7777;

/** Hilfsfunktionen **/

/** Wandelt IPv4-String "a.b.c.d" in ein 32-Bit-Integer (Big-Endian) */
function ipToUint32(ipStr) {
  const parts = ipStr.split('.').map(p => parseInt(p, 10));
  return ((parts[0] << 24) >>> 0)
       + ((parts[1] << 16) >>> 0)
       + ((parts[2] << 8)  >>> 0)
       +  (parts[3]       >>> 0);
}

/** Umkehrung: 32-Bit-Integer -> IPv4-String "a.b.c.d" */
function uint32ToIp(num) {
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff
  ].join('.');
}

/** Error-Codes in Klartext. */
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

/** Nachrichten-Builder gemäß Spezifikation **/

/**
 * Registrierungs-Nachricht (ID=1):
 *  1 Byte  msg_id=1
 *  4 Byte  ip
 *  2 Byte  udp_port
 *  1 Byte  name_len
 *  N Byte  name
 */
function buildRegistrationMessage(ip, udpPort, name) {
  const nameBuf = Buffer.from(name, 'utf8');
  const buf = Buffer.alloc(1 + 4 + 2 + 1 + nameBuf.length);

  let offset = 0;
  buf.writeUInt8(1, offset);         // msg_id=1
  offset += 1;
  buf.writeUInt32BE(ip, offset);     // 4 Byte IP
  offset += 4;
  buf.writeUInt16BE(udpPort, offset); // 2 Byte UDP-Port
  offset += 2;
  buf.writeUInt8(nameBuf.length, offset); // 1 Byte Name-Länge
  offset += 1;
  nameBuf.copy(buf, offset);         // N Byte Name
  return buf;
}

/**
 * Broadcast (ID=6):
 *  1 Byte msg_id=6
 *   Byte msg_len
 *  N Byte msg
 */
function buildBroadcastMessage(text) {
  const textBuf = Buffer.from(text, 'utf8');
  const buf = Buffer.alloc(1 + 4 + textBuf.length);

  let offset = 0;
  buf.writeUInt8(6, offset);  // msg_id=6
  offset += 1;
  buf.writeUInt16BE(textBuf.length, offset);
  offset += 2;
  textBuf.copy(buf, offset);
  return buf;
}

/**
 * Disconnect (ID=7):
 *  1 Byte msg_id=7
 */
function buildDisconnectMessage() {
  const buf = Buffer.alloc(1);
  buf.writeUInt8(7, 0);
  return buf;
}

/**
 * Peer-To-Peer Request (ID=8) via UDP:
 *  1 Byte  msg_id=8
 *  2 Byte  tcp_port
 *  1 Byte  name_len
 *  N Byte  name
 */
function buildPeerToPeerRequest(myTcpPort, myName) {
  const nameBuf = Buffer.from(myName, 'utf8');
  const buf = Buffer.alloc(1 + 2 + 1 + nameBuf.length);

  let offset = 0;
  buf.writeUInt8(8, offset);          // msg_id=8
  offset += 1;
  buf.writeUInt16BE(myTcpPort, offset); // 2 Byte
  offset += 2;
  buf.writeUInt8(nameBuf.length, offset);
  offset += 1;
  nameBuf.copy(buf, offset);
  return buf;
}

/**
 * Peer-To-Peer Message (ID=9) via TCP:
 *  1 Byte  msg_id=9
 *  4 Byte  msg_len
 *  N Byte  msg
 */
function buildPeerToPeerMessage(text) {
  const textBuf = Buffer.from(text, 'utf8');
  const buf = Buffer.alloc(1 + 4 + textBuf.length);

  let offset = 0;
  buf.writeUInt8(9, offset);
  offset += 1;
  buf.writeUInt32BE(textBuf.length, offset);
  offset += 4;
  textBuf.copy(buf, offset);
  return buf;
}

/** Globale Variablen **/
let myName = '';                // Unser Nickname
let myIpUint32 = 0;             // Unsere IP in UInt32
let serverHost = '';            // Server IP/Host
let tcpSocket = null;           // TCP-Verbindung zum Server

/**
 * Das hier ist der lokale UDP-Port, über den wir ID=8-Anfragen empfangen.
 * Hier ganz einfach ein Zufallsport im Bereich 30000..30999.
 */
let localUdpPort = 30000 + Math.floor(Math.random() * 1000);

/**
 * clientList = Liste aller vom Server bekannten Clients
 * (jeweils { ip, udpPort, name }).
 */
const clientList = [];

/**
 * openP2PSessions = Map<Name, net.Socket> - offene P2P-TCP-Verbindungen
 * (ein Socket pro verbundener Peer).
 */
const openP2PSessions = {};

/**
 * Wir benötigen noch eine Zuordnung IP->Name, um den "Namen" zu kennen,
 * wenn wir von einer bestimmten IP eine UDP-Anfrage oder TCP-Connect erhalten.
 * Genauso wie in deinem Go-Beispiel p2pCandidates.
 */
const p2pCandidates = {};

/**
 * Wir starten einen globalen "P2P-Server" auf Port=0 (d.h. OS wählt Port),
 * aber hier machen wir es **wie im Go-Code**:
 *    - Nur der Initiator startet kurz (ad-hoc) einen ephemeral TCP-Server,
 *      verschickt Msg=8, und wartet EINMAL auf connect.
 *    - Der "Empfänger" erhält via UDP die Port-Info und baut selbst eine TCP-Verbindung auf.
 *
 * => Also implementieren wir "initiateP2P" + "handleIncomingP2PConnection".
 */

/**
 * Starte ad-hoc einen TCP-Server auf einem ephemeral Port, wenn wir
 * (als Initiator) mit /p2p <name> eine Verbindung zu <name> aufbauen wollen.
 */
function initiateP2PChat(targetName) {
  // 1) Finde IP/UDP-Port in clientList
  const target = clientList.find(c => c.name === targetName);
  if (!target) {
    console.log(`[P2P] Unbekannter Name: ${targetName}`);
    return;
  }
  const ipStr = uint32ToIp(target.ip);

  // 2) Lokalen TCP-Server starten (Port=0 => ephemeral)
  const server = net.createServer();

  server.listen(0, () => {
    const chosenPort = server.address().port;
    console.log(`[P2P] Starte lokalen TCP-Server (Port=${chosenPort}) für ${targetName}.`);

    // 3) Schicke UDP-Paket (ID=8) an target.ip:target.udpPort
    const udpReq = buildPeerToPeerRequest(chosenPort, myName);

    const udpSender = dgram.createSocket('udp4');
    udpSender.send(
      udpReq,
      0,
      udpReq.length,
      target.udpPort,
      ipStr,
      (err) => {
        udpSender.close();
        if (err) {
          console.log('[P2P] Fehler beim Senden der UDP-Anfrage:', err.message);
        } else {
          console.log(`[P2P] P2P-Anfrage (ID=8) an ${targetName} => IP=${ipStr}:${target.udpPort}, chosenPort=${chosenPort}`);
        }
      }
    );
  });

  // 4) Warte auf EINE eingehende Verbindung => Peer connected
  server.once('connection', (socket) => {
    console.log(`[P2P] ${targetName} hat sich verbunden (Port=${server.address().port}).`);
    openP2PSessions[targetName] = socket;
    handlePeerMessages(socket, targetName);

    // Wir erlauben nur EINE Verbindung, dann Server wieder schließen:
    server.close();
  });

  server.on('error', (err) => {
    console.log('[P2P] Fehler in ephemeral TCP-Server:', err.message);
  });
}

/**
 * handlePeerMessages: Liest ID=9-Pakete vom Socket und gibt sie aus.
 */
function handlePeerMessages(socket, remoteName) {
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    parseMessages();
  });

  socket.on('close', () => {
    console.log(`[P2P] Verbindung zu ${remoteName} geschlossen.`);
    if (openP2PSessions[remoteName] === socket) {
      delete openP2PSessions[remoteName];
    }
  });

  socket.on('error', (err) => {
    console.log(`[P2P] Fehler in Verbindung zu ${remoteName}: ${err.message}`);
  });

  function parseMessages() {
    let offset = 0;
    while (offset + 5 <= buffer.length) {
      const msgId = buffer.readUInt8(offset);
      if (msgId !== 9) {
        console.log(`[P2P] Unbekannte Msg-ID=${msgId}, erwartet 9`);
        return;
      }
      const msgLen = buffer.readUInt32BE(offset + 1);
      if (offset + 5 + msgLen > buffer.length) {
        // unvollständig
        break;
      }
      const text = buffer.slice(offset + 5, offset + 5 + msgLen).toString('utf8');
      console.log(`[P2P-Chat] Von ${remoteName}: ${text}`);
      offset += 5 + msgLen;
    }
    buffer = buffer.slice(offset);
  }
}

/**
 * Wenn WIR eine TCP-Verbindung zu <ip:port> aufbauen (also als Empfänger),
 * legen wir den Socket in openP2PSessions und parsen ID=9-Nachrichten.
 */
function connectAsReceiver(ipStr, tcpPort, remoteName) {
  console.log(`[P2P] Baue TCP-Verbindung (als Empfänger) zu ${remoteName} (IP=${ipStr},Port=${tcpPort}) auf...`);
  const socket = net.createConnection({ host: ipStr, port: tcpPort }, () => {
    console.log(`[P2P] TCP-Verbindung zu ${remoteName} hergestellt!`);
    openP2PSessions[remoteName] = socket;
    handlePeerMessages(socket, remoteName);
  });

  socket.on('error', (err) => {
    console.log(`[P2P] Fehler bei Connect zu ${remoteName}: ${err.message}`);
  });
}

/**
 * P2P-Nachricht (ID=9) an <remoteName> schicken (falls Session existiert).
 */
function sendP2PMessage(remoteName, text) {
  const sock = openP2PSessions[remoteName];
  if (!sock) {
    console.log(`[P2P] Keine offene Verbindung zu "${remoteName}". Bitte /p2p <name> zuerst?`);
    return;
  }
  const msg = buildPeerToPeerMessage(text);
  sock.write(msg);
  console.log(`[P2P] Gesendet an ${remoteName}: ${text}`);
}

/**
 * Lokales UDP-Socket, auf dem wir ID=8-Anfragen empfangen.
 * => Wenn wir so eine Anfrage empfangen, bedeutet das:
 *    "Bitte verbinde dich auf meinem ephemeral TCP-Port".
 * => Also bauen wir hier als "Empfänger" die TCP-Verbindung auf.
 */
function startUdpListener() {
  const udpServer = dgram.createSocket('udp4');
  udpServer.on('message', (msg, rinfo) => {
    if (msg.length < 1) return;
    const msgId = msg.readUInt8(0);
    if (msgId !== 8) {
      console.log('[UDP] Unbekannte Msg-ID=', msgId);
      return;
    }
    // => 1 Byte=8, 2 Byte=Port, 1 Byte=NameLen, N Byte=Name
    if (msg.length < 4) return;
    const theirTcpPort = msg.readUInt16BE(1);
    const nameLen = msg.readUInt8(3);
    if (msg.length < 4 + nameLen) return;
    const theirName = msg.slice(4, 4 + nameLen).toString('utf8');

    console.log(`[UDP] Anfrage (ID=8) von ${theirName} (IP=${rinfo.address}, UDP-SourcePort=${rinfo.port}), ihr TCP-Port=${theirTcpPort}`);

    // => B baue TCP-Verbindung zu (rinfo.address: theirTcpPort) auf
    connectAsReceiver(rinfo.address, theirTcpPort, theirName);
  });

  udpServer.on('listening', () => {
    const addr = udpServer.address();
    console.log(`[P2P] UDP-Socket lauscht auf ${addr.address}:${addr.port} (für ID=8).`);
  });

  // Binde an localUdpPort
  udpServer.bind(localUdpPort);
}

/**
 * Startet die einfache TUI
 */
function startTUI(rl) {
  console.log('Verfügbare Befehle:');
  console.log('   /list                       - Liste aller Clients');
  console.log('   /broadcast <text>           - Broadcast an alle');
  console.log('   /p2p <name>                 - Starte P2P-Verbindung (Initiator-Rolle)');
  console.log('   /p2pmsg <name> <text>       - Schicke (ID=9) P2P-Chat-Nachricht an <name>');
  console.log('   /exit                       - Disconnect (ID=7) und beenden\n');

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) return;

    if (input.startsWith('/list')) {
      console.log('Aktuelle Clients:');
      clientList.forEach(c => {
        console.log(`  - ${c.name} [${uint32ToIp(c.ip)}:${c.udpPort}]`);
      });

    } else if (input.startsWith('/broadcast ')) {
      const text = input.substring('/broadcast '.length).trim();
      if (text && tcpSocket) {
        const buf = buildBroadcastMessage(text);
        tcpSocket.write(buf);
      }

    } else if (input.startsWith('/p2p ')) {
      // /p2p <name>
      const targetName = input.substring('/p2p '.length).trim();
      if (!targetName) return;
      initiateP2PChat(targetName);

    } else if (input.startsWith('/p2pmsg ')) {
      // /p2pmsg <name> <text>
      const parts = input.split(' ');
      if (parts.length < 3) {
        console.log('Verwendung: /p2pmsg <name> <text>');
        return;
      }
      const targetName = parts[1];
      const msgText = parts.slice(2).join(' ');
      sendP2PMessage(targetName, msgText);

    } else if (input.startsWith('/exit')) {
      // Disconnect (ID=7) an den Server
      if (tcpSocket) {
        const discMsg = buildDisconnectMessage();
        tcpSocket.write(discMsg);
        tcpSocket.end();
      }
      // UDP-Socket schließen
      // (falls man will: hier udpSocket.close(), wir haben es in startUdpListener())
      // Offene P2P-Sockets schließen
      Object.entries(openP2PSessions).forEach(([key, s]) => s.destroy());

      rl.close();
      process.exit(0);

    } else {
      console.log('Unbekannter Befehl. Siehe /list, /broadcast, /p2p, /p2pmsg, /exit');
    }
  });
}

/**
 * Hauptprogramm:
 *  1) Startet UDP-Listener (für ID=8)
 *  2) Fragt Name & Server-IP ab
 *  3) Verbindet sich per TCP zum Server -> Registrierung (ID=1)
 *  4) Startet TUI
 */
async function main() {
  // 1) Start UDP
  startUdpListener();

  // 2) TUI + Registrierung
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('Deine lokale IP-Adresse (z.B. 127.0.0.1): ', (answerIp) => {
    const localIP = answerIp.trim();
    if (!localIP) {
      console.log('Keine lokale IP angegeben. Abbruch.');
      process.exit(1);
    }

    myIpUint32 = ipToUint32(localIP);

    // Name abfragen
    rl.question('Dein Chat-Name: ', (answerName) => {
      myName = answerName.trim();
      if (!myName) {
        console.log('Kein Name eingegeben. Abbruch.');
        process.exit(1);
      }

      // Server-Host abfragen
      rl.question('Server IP/Hostname (z.B. 127.0.0.1): ', (answerHost) => {
        serverHost = answerHost.trim();
        if (!serverHost) {
          console.log('Keine Server-Host-Angabe. Abbruch.');
          process.exit(1);
        }

        // TCP-Verbindung zum Server
        tcpSocket = net.createConnection({ host: serverHost, port: SERVER_TCP_PORT }, () => {
          console.log(`[Client] Verbunden mit Server ${serverHost}:${SERVER_TCP_PORT}`);

          // Registrierung (ID=1)
          const regMsg = buildRegistrationMessage(myIpUint32, localUdpPort, myName);
          tcpSocket.write(regMsg);

          // TUI starten
          startTUI(rl);
        });

        let serverBuffer = Buffer.alloc(0);
        tcpSocket.on('data', (chunk) => {
          serverBuffer = Buffer.concat([serverBuffer, chunk]);
          parseServerMessages();
        });

        tcpSocket.on('error', (err) => {
          console.log('[Client] TCP-Fehler:', err.message);
          process.exit(1);
        });

        tcpSocket.on('close', () => {
          console.log('[Client] Verbindung zum Server geschlossen.');
          process.exit(0);
        });

        // Parsing loop für Nachrichten vom Server
        function parseServerMessages() {
            let offset = 0;
            while (offset < serverBuffer.length) {
            if (offset + 1 > serverBuffer.length) break;
            const msgId = serverBuffer.readUInt8(offset);
            switch (msgId) {
                case 0: {
                // Error => 2 Byte
                if (offset + 2 > serverBuffer.length) return;
                const errorCode = serverBuffer.readUInt8(offset + 1);
                console.log(`[Server] Error-Code=${errorCode} => ${decodeErrorCode(errorCode)}`);
                offset += 2;
                break;
                }
                case 2: {
                // Registrierung Antwort
                // (1 Byte=2) + (4 Byte Anzahl) + M * (4 Byte IP + 2 Byte UDP + 1 Byte len + Name)
                if (offset + 5 > serverBuffer.length) return;
                const count = serverBuffer.readUInt32BE(offset + 1);
                let innerOffset = offset + 5;
                const newList = [];
                for (let i = 0; i < count; i++) {
                    if (innerOffset + 7 > serverBuffer.length) return;
                    const ip = serverBuffer.readUInt32BE(innerOffset);
                    innerOffset += 4;
                    const udp = serverBuffer.readUInt16BE(innerOffset);
                    innerOffset += 2;
                    const nameLen = serverBuffer.readUInt8(innerOffset);
                    innerOffset += 1;
                    if (innerOffset + nameLen > serverBuffer.length) return;
                    const name = serverBuffer.slice(innerOffset, innerOffset + nameLen).toString('utf8');
                    innerOffset += nameLen;
                    newList.push({ ip, udpPort: udp, name });
                }
                offset = innerOffset;
                clientList.splice(0, clientList.length, ...newList);
                console.log('[Client] Registrierung OK. Aktuelle Clients:');
                clientList.forEach(c => {
                    console.log(`  - ${c.name} [${uint32ToIp(c.ip)}:${c.udpPort}]`);
                });
                break;
                }
                case 4: {
                // Neuer Client
                if (offset + 8 > serverBuffer.length) return;
                const ip = serverBuffer.readUInt32BE(offset + 1);
                const udpPort = serverBuffer.readUInt16BE(offset + 5);
                const nameLen = serverBuffer.readUInt8(offset + 7);
                if (offset + 8 + nameLen > serverBuffer.length) return;
                const name = serverBuffer.slice(offset + 8, offset + 8 + nameLen).toString('utf8');
                offset += 8 + nameLen;
                clientList.push({ ip, udpPort, name });
                console.log(`[Client] Neuer Client: ${name} [${uint32ToIp(ip)}:${udpPort}]`);
                break;
                }
                case 5: {
                // Client Disconnected
                if (offset + 2 > serverBuffer.length) return;
                const nameLen = serverBuffer.readUInt8(offset + 1);
                if (offset + 2 + nameLen > serverBuffer.length) return;
                const discName = serverBuffer.slice(offset + 2, offset + 2 + nameLen).toString('utf8');
                offset += 2 + nameLen;
                const idx = clientList.findIndex(c => c.name === discName);
                if (idx !== -1) {
                    clientList.splice(idx, 1);
                }
                console.log(`[Client] "${discName}" hat den Chat verlassen.`);
                break;
                }
                case 6: {
                // Broadcast
                if (offset + 5 > serverBuffer.length) return;
                const msgLen = serverBuffer.readUInt32BE(offset + 1);
                if (offset + 5 + msgLen > serverBuffer.length) return;
                const text = serverBuffer.slice(offset + 5, offset + 5 + msgLen).toString('utf8');
                offset += 5 + msgLen;
                console.log(`[Broadcast] ${text}`);
                break;
                }
                default:
                console.log(`[Client] Unbekannte msg_id=${msgId}`);
                return;
            }
            }
            if (offset > 0) {
            serverBuffer = serverBuffer.slice(offset);
            }
        }
        });
    });
  });
}

/** Start! */
main().catch(err => {
  console.error(err);
  process.exit(1);
});
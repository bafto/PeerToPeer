#!/usr/bin/env node

/**
 * Einfacher Chat-Client.
 * - Verbindet sich via TCP mit Server (Port 7777).
 * - Meldet sich mit Msg-ID=1 an (Registrierung).
 * - Empfängt die Liste aller Clients (Msg-ID=2).
 * - Empfängt "New Client Connected" (ID=4), "Client Disconnected" (ID=5),
 *   "Broadcast" (ID=6) etc.
 * - Kann Broadcasts schicken (ID=6).
 * - Kann sich abmelden (ID=7).
 * - Startet einen UDP-Socket für P2P Chat (Msg-IDs 8 und 9).
 */

const net = require('net');
const dgram = require('dgram');
const readline = require('readline');

/** Konfiguration **/
const SERVER_HOST = '162.55.58.113';
const SERVER_TCP_PORT = 7777;

// Die lokale UDP-Socket, auf der wir P2P-Nachrichten empfangen
let localUdpPort = 30000 + Math.floor(Math.random() * 1000);

/**
 * Hilfsfunktionen
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
 * Dekodiert Error-Codes in einen Text (für die Ausgabe im Client).
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

/** Globale Variablen zum Client */
let myName = '';
let myIpUint32 = 0;
let tcpSocket = null; // TCP Verbindung zum Server
const clientList = []; // Wird durch RegistrationResponse befüllt

// Peer-to-Peer: wir speichern hier geöffnete TCP-Verbindungen
//   key = <nickname>, value = net.Socket
const openP2PSessions = {};

/**
 * Erstellt eine Buffer-Nachricht zur Registrierung (ID=1).
 * Struktur:
 *  1 Byte Msg-ID=1
 *  4 Byte IP
 *  2 Byte UDP-Port
 *  1 Byte Name-Länge
 *  N Byte Name
 */
function buildRegistrationMessage(ip, udpPort, name) {
  const nameBuf = Buffer.from(name, 'utf8');
  const msg = Buffer.alloc(1 + 4 + 2 + 1 + nameBuf.length);

  let offset = 0;
  msg.writeUInt8(1, offset); // 1
  offset += 1;
  msg.writeUInt32BE(ip, offset);
  offset += 4;
  msg.writeUInt16BE(udpPort, offset);
  offset += 2;
  msg.writeUInt8(nameBuf.length, offset);
  offset += 1;
  nameBuf.copy(msg, offset);

  return msg;
}

/**
 * Broadcast-Nachricht (ID=6)
 *  1 Byte: Msg-ID=6
 *  4 Byte: length
 *  N Byte: UTF-8
 */
function buildBroadcastMessage(text) {
  const textBuf = Buffer.from(text, 'utf8');
  const buf = Buffer.alloc(1 + 4 + textBuf.length);
  buf.writeUInt8(6, 0);
  buf.writeUInt32BE(textBuf.length, 1);
  textBuf.copy(buf, 5);
  return buf;
}

/**
 * Client-Disconnect (ID=7)
 */
function buildDisconnectMessage() {
  const buf = Buffer.alloc(1);
  buf.writeUInt8(7, 0);
  return buf;
}

/**
 * Peer-To-Peer Request (UDP, ID=8)
 * 1 Byte Msg-ID=8
 * 2 Byte TCP-Port
 * 1 Byte Name-Länge
 * N Byte Name
 */
function buildPeerToPeerRequest(tcpPort, myName) {
  const nameBuf = Buffer.from(myName, 'utf8');
  const buf = Buffer.alloc(1 + 2 + 1 + nameBuf.length);
  buf.writeUInt8(8, 0);
  buf.writeUInt16BE(tcpPort, 1);
  buf.writeUInt8(nameBuf.length, 3);
  nameBuf.copy(buf, 4);
  return buf;
}

/**
 * Peer-To-Peer Message (UDP, ID=9)
 * 1 Byte Msg-ID=9
 * 4 Byte msgLen
 * N Byte Nachricht
 */
function buildPeerToPeerMessage(text) {
  const textBuf = Buffer.from(text, 'utf8');
  const buf = Buffer.alloc(1 + 4 + textBuf.length);
  buf.writeUInt8(9, 0);
  buf.writeUInt32BE(textBuf.length, 1);
  textBuf.copy(buf, 5);
  return buf;
}

/**
 * TCP-Server für eingehende P2P-Verbindungen starten
 */
let p2pTcpServer = null;
let myP2pTcpPort = 0; // Tatsächlich belegter Port

function startP2PServer() {
  return new Promise((resolve) => {
    p2pTcpServer = net.createServer((sock) => {
      // Neue P2P-Verbindung
      console.log(`\n[P2P] Neuer TCP Chat eingegangen von ${sock.remoteAddress}:${sock.remotePort}`);

      sock.on('data', (chunk) => {
        const msgText = chunk.toString('utf8');
        console.log(`[P2P-Chat] ${msgText}`);
      });

      sock.on('close', () => {
        console.log('[P2P] Verbindung geschlossen.');
      });

      // Kein explizites Speichern unter openP2PSessions (da wir hier den Nickname des Gegenübers nicht direkt kennen)
      // Man könnte diesen per Protokoll aushandeln.
    });

    // Auf beliebigem freien Port lauschen
    p2pTcpServer.listen(0, () => {
      myP2pTcpPort = p2pTcpServer.address().port;
      console.log(`[P2P] Wir lauschen jetzt auf TCP-Port ${myP2pTcpPort} für Peer-Verbindungen.`);
      resolve();
    });
  });
}

/**
 * UDP-Socket erstellen, um eingehende P2P-Anfragen (ID=8) oder
 * P2P-Nachrichten (ID=9) zu behandeln.
 */
const udpSocket = dgram.createSocket('udp4');

udpSocket.on('message', (msg, rinfo) => {
  const msgId = msg.readUInt8(0);
  switch (msgId) {
    case 8: {
      // P2P-Chat-Anfrage
      // 1 Byte=8
      // 2 Byte=TCP-Port
      // 1 Byte=NameLen
      // N Byte=Name
      if (msg.length < 1 + 2 + 1) return;

      const theirTcpPort = msg.readUInt16BE(1);
      const nameLen = msg.readUInt8(3);
      if (msg.length < 4 + nameLen) return;

      const theirName = msg.slice(4, 4 + nameLen).toString('utf8');
      console.log(`\n[P2P] Chat-Anfrage von ${theirName} (IP=${rinfo.address}:${rinfo.port}, TCP-Port=${theirTcpPort})`);
      console.log(`[P2P] Baue TCP-Verbindung auf...`);

      // Wir bauen als Empfänger die TCP-Verbindung auf
      const p2pSock = net.createConnection({ host: rinfo.address, port: theirTcpPort }, () => {
        console.log(`[P2P] TCP-Verbindung zu ${theirName} aufgebaut. Nutze /p2pmsg für Nachrichten.`);
        openP2PSessions[theirName] = p2pSock;
      });

      p2pSock.on('data', (chunk) => {
        const msgText = chunk.toString('utf8');
        console.log(`[P2P-Chat] ${theirName}: ${msgText}`);
      });

      p2pSock.on('error', (err) => {
        console.log('[P2P] Fehler:', err.message);
      });

      p2pSock.on('close', () => {
        console.log(`[P2P] Verbindung zu ${theirName} geschlossen.`);
        delete openP2PSessions[theirName];
      });

      break;
    }
    case 9: {
      // P2P Nachricht (UDP) – in diesem Beispiel nicht so relevant,
      // weil wir P2P-Chat über TCP machen wollen.
      // Aber wir nehmen es hier mal mit auf.
      if (msg.length < 1 + 4) return;
      const msgLen = msg.readUInt32BE(1);
      if (msg.length < 5 + msgLen) return;
      const text = msg.slice(5, 5 + msgLen).toString('utf8');
      console.log(`[P2P-UDP] Von ${rinfo.address}:${rinfo.port} => ${text}`);
      break;
    }
    default:
      console.log('[UDP] Unbekannte Msg-ID:', msgId);
      break;
  }
});

udpSocket.bind(localUdpPort, () => {
  console.log(`UDP-Socket lauscht auf Port ${localUdpPort} (für P2P).`);
});

/**
 * TCP-Verbindung zum Server aufbauen und Registrierung senden.
 */
async function main() {
  // Starte P2P-TCP-Server
  await startP2PServer();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Frage den Benutzernamen ab
  rl.question('Dein Chat-Name: ', (answer) => {
    myName = answer.trim();
    if (!myName) {
      console.log('Kein Name eingegeben. Abbruch.');
      process.exit(1);
    }

    tcpSocket = net.createConnection({ host: SERVER_HOST, port: SERVER_TCP_PORT }, () => {
      console.log('Verbunden mit dem Chat-Server.');

      // IP in uint32 umwandeln (nur als "Fake", wir könnten auch 127.0.0.1 nehmen)
      const localIP = tcpSocket.localAddress || '127.0.0.1';
      myIpUint32 = ipToUint32(localIP);

      // Registrierung senden (ID=1)
      const regMsg = buildRegistrationMessage(myIpUint32, localUdpPort, myName);
      tcpSocket.write(regMsg);

      startTUI(rl);
    });

    tcpSocket.on('data', (data) => {
      handleServerMessage(data);
    });

    tcpSocket.on('error', (err) => {
      console.log('TCP-Fehler:', err.message);
      process.exit(1);
    });

    tcpSocket.on('close', () => {
      console.log('Verbindung zum Server geschlossen.');
      process.exit(0);
    });
  });
}

/**
 * Nachrichten vom Server verarbeiten.
 */
function handleServerMessage(buf) {
  const msgId = buf.readUInt8(0);
  switch (msgId) {
    case 0: {
      // Error
      const errorCode = buf.readUInt8(1);
      console.log(`Server-Fehlermeldung: Code=${errorCode} => ${decodeErrorCode(errorCode)}`);
      break;
    }
    case 2: {
      // Registrierung Antwort
      // 1 Byte: Msg-ID=2
      // 4 Byte: Anzahl Clients
      // dann M Client-Einträge
      let offset = 1;
      const count = buf.readUInt32BE(offset);
      offset += 4;
      clientList.length = 0; // leeren
      for (let i = 0; i < count; i++) {
        const ip = buf.readUInt32BE(offset); offset += 4;
        const udpPort = buf.readUInt16BE(offset); offset += 2;
        const nameLen = buf.readUInt8(offset); offset += 1;
        const name = buf.slice(offset, offset + nameLen).toString('utf8');
        offset += nameLen;
        clientList.push({ ip, udpPort, name });
      }
      console.log('Registrierung erfolgreich. Aktuelle Clients:');
      clientList.forEach(c => {
        console.log(`  - ${c.name} [${uint32ToIp(c.ip)}:${c.udpPort}]`);
      });
      break;
    }
    case 4: {
      // Neuer Client Connected
      let offset = 1;
      const ip = buf.readUInt32BE(offset); offset += 4;
      const udpPort = buf.readUInt16BE(offset); offset += 2;
      const nameLen = buf.readUInt8(offset); offset += 1;
      const name = buf.slice(offset, offset + nameLen).toString('utf8');
      offset += nameLen;

      clientList.push({ ip, udpPort, name });
      console.log(`Neuer Client im Chat: ${name} [${uint32ToIp(ip)}:${udpPort}]`);
      break;
    }
    case 5: {
      // Client Disconnected
      let offset = 1;
      const nameLen = buf.readUInt8(offset); offset += 1;
      const name = buf.slice(offset, offset + nameLen).toString('utf8');
      offset += nameLen;

      // Aus clientList entfernen
      const idx = clientList.findIndex(c => c.name === name);
      if (idx !== -1) {
        clientList.splice(idx, 1);
      }

      console.log(`Client hat Chat verlassen: ${name}`);
      break;
    }
    case 6: {
      // Broadcast
      let offset = 1;
      const msgLen = buf.readUInt32BE(offset); offset += 4;
      const text = buf.slice(offset, offset + msgLen).toString('utf8');
      console.log(`[Broadcast] ${text}`);
      break;
    }
    default:
      console.log(`Unbekannte Server-Nachricht ID=${msgId}`);
      break;
  }
}

/**
 * TUI starten.
 */
function startTUI(rl) {
  console.log('Befehle:');
  console.log('  /list                - Zeigt aktuelle Clients an');
  console.log('  /broadcast <text>    - Sendet Broadcast an alle');
  console.log('  /p2p <name>          - Fordert P2P-Chat mit <name> an (UDP Msg=8)');
  console.log('  /p2pmsg <name> <txt> - Schickt <txt> via bereits aufgebauter TCP-P2P-Verbindung an <name>');
  console.log('  /exit                - Trennt vom Server');

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
      if (text) {
        // Sende Broadcast an Server
        const msg = buildBroadcastMessage(text);
        tcpSocket.write(msg);
      }
    } else if (input.startsWith('/p2p ')) {
      // UDP Chat Request (ID=8) an den gewünschten Nutzer
      const targetName = input.substring('/p2p '.length).trim();
      if (!targetName) return;
      const target = clientList.find(c => c.name === targetName);
      if (!target) {
        console.log('Unbekannter Name.');
        return;
      }
      // Chat-Anfrage
      const p2pReq = buildPeerToPeerRequest(myP2pTcpPort, myName);
      udpSocket.send(p2pReq, 0, p2pReq.length, target.udpPort, uint32ToIp(target.ip), (err) => {
        if (err) console.log('UDP-P2P-Fehler:', err.message);
        else console.log(`[P2P] Anfrage an ${targetName} gesendet (UDP).`);
      });
    } else if (input.startsWith('/p2pmsg ')) {
      // /p2pmsg <name> <text>
      const args = input.split(' ');
      if (args.length < 3) {
        console.log('Verwendung: /p2pmsg <name> <text>');
        return;
      }
      const targetName = args[1];
      const msgText = args.slice(2).join(' ');
      const p2pSock = openP2PSessions[targetName];
      if (!p2pSock) {
        console.log(`Keine offene P2P-Verbindung zu ${targetName}.`);
        return;
      }
      // Einfach String direkt senden
      p2pSock.write(msgText);
    } else if (input.startsWith('/exit')) {
      // Beenden
      console.log('Verbindung zum Server trennen...');
      const discMsg = buildDisconnectMessage();
      tcpSocket.write(discMsg);
      tcpSocket.end();

      // UDP-Socket schließen
      udpSocket.close();
      rl.close();
    } else {
      console.log('Unbekannter Befehl. Verfügbar: /list, /broadcast, /p2p, /p2pmsg, /exit');
    }
  });
}

// Starten
main().catch(err => {
  console.error(err);
  process.exit(1);
});
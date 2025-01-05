const net = require('net');

const clients = {};

const server = net.createServer((socket) => {
    console.log('Client connected:', socket.remoteAddress, socket.remotePort);

    socket.on('data', (data) => {
        try {
            const msgId = data.readUInt8(0);
            if (msgId === 1) { // Registrierung
                const clientIp = socket.remoteAddress;
                const clientPort = data.readUInt16BE(1);
                const nameLen = data.readUInt8(3);
                const name = data.slice(4, 4 + nameLen).toString('utf8');

                if (clients[name]) {
                    console.log(`Duplicate client name: ${name}`);
                    socket.write(Buffer.from([0, 3])); // Fehler: Nickname nicht unique
                    return;
                }

                clients[name] = { ip: clientIp, port: clientPort, socket };
                console.log(`Registered client: ${name}`);

                // Send client list
                const clientList = Object.entries(clients).map(([key, val]) => {
                    const nameBuffer = Buffer.from(key, 'utf8');
                    return Buffer.concat([
                        Buffer.from([val.ip.split('.').map(Number)]), // IP
                        Buffer.alloc(2, val.port), // Port
                        Buffer.from([nameBuffer.length]), // Name Length
                        nameBuffer, // Name
                    ]);
                });
                const response = Buffer.concat([
                    Buffer.from([2]), // Msg-ID
                    Buffer.alloc(4, clientList.length), // Anzahl Clients
                    ...clientList,
                ]);
                socket.write(response);
            } else {
                console.log(`Unknown Msg-ID: ${msgId}`);
                socket.write(Buffer.from([0, 0])); // Fehler: Unbekannte Msg-ID
            }
        } catch (error) {
            console.error('Error handling data:', error.message);
        }
    });

    socket.on('close', () => {
        console.log('Client disconnected:', socket.remoteAddress, socket.remotePort);
        for (const [key, val] of Object.entries(clients)) {
            if (val.socket === socket) {
                delete clients[key];
                console.log(`Removed client: ${key}`);
                break;
            }
        }
    });
});

server.listen(7777, () => {
    console.log('Server listening on port 7777');
});
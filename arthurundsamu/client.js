const net = require('net');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const serverIp = '127.0.0.1';
const serverPort = 7777;

const socket = new net.Socket();

socket.connect(serverPort, serverIp, () => {
    console.log('Connected to server');
    registerClient();
});

socket.on('data', (data) => {
    const msgId = data.readUInt8(0);
    if (msgId === 2) { // Registrierung erfolgreich
        console.log('Client list received:', data.toString());
    } else {
        console.log('Unknown server response:', data.toString());
    }
});

socket.on('close', () => {
    console.log('Disconnected from server');
});

function registerClient() {
    rl.question('Enter your nickname: ', (nickname) => {
        const nameBuffer = Buffer.from(nickname, 'utf8');
        const registrationRequest = Buffer.concat([
            Buffer.from([1]), // Msg-ID
            Buffer.alloc(4, socket.localAddress.split('.').map(Number)), // IP
            Buffer.alloc(2, 12345), // UDP Port (dummy)
            Buffer.from([nameBuffer.length]), // Name length
            nameBuffer, // Name
        ]);
        socket.write(registrationRequest);
        showMenu();
    });
}

function showMenu() {
    console.log('\n1. Broadcast Message');
    console.log('2. Exit');
    rl.question('Choose an option: ', (option) => {
        if (option === '1') {
            rl.question('Enter message to broadcast: ', (msg) => {
                const msgBuffer = Buffer.from(msg, 'utf8');
                const broadcastMessage = Buffer.concat([
                    Buffer.from([6]), // Msg-ID
                    Buffer.alloc(2, msgBuffer.length), // Msg length
                    msgBuffer, // Message
                ]);
                socket.write(broadcastMessage);
                showMenu();
            });
        } else if (option === '2') {
            socket.end();
            rl.close();
        } else {
            console.log('Invalid option');
            showMenu();
        }
    });
}
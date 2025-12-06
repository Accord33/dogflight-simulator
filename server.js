/**
 * Lightweight WebSocket relay for Ace Wing online modes.
 * Run with: `npm install ws` then `node server.js`
 */
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3001;
const MAX_PLAYERS = 2;

const rooms = new Map();
const matchQueue = [];

function now() {
    return Date.now();
}

function createRoomCode() {
    return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function getRoom(code) {
    if (!rooms.has(code)) {
        rooms.set(code, {
            code,
            clients: new Map(),
            mode: null,
            stage: null,
            createdAt: now()
        });
    }
    return rooms.get(code);
}

function broadcast(room, data, exceptId) {
    const payload = JSON.stringify(data);
    for (const [id, client] of room.clients.entries()) {
        if (client.readyState === WebSocket.OPEN && id !== exceptId) {
            client.send(payload);
        }
    }
}

function joinRoom(ws, { roomCode, mode, stage }) {
    const room = getRoom(roomCode);
    if (room.clients.size >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
        return { error: 'Room full' };
    }
    if (room.mode && room.mode !== mode) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room mode mismatch' }));
        return { error: 'Room mode mismatch' };
    }

    room.mode = room.mode || mode || 'ONLINE_VS';
    room.stage = room.stage || stage || 'OCEAN';

    ws.room = room;
    ws.isHost = room.clients.size === 0;
    room.clients.set(ws.id, ws);

    ws.send(JSON.stringify({
        type: 'welcome',
        playerId: ws.id,
        isHost: ws.isHost,
        room: room.code,
        mode: room.mode,
        stage: room.stage,
        count: room.clients.size
    }));

    broadcast(room, { type: 'player-join', playerId: ws.id, count: room.clients.size }, ws.id);
    console.log(`[ws] ${ws.id} joined room ${room.code} host=${ws.isHost}`);
    return { room };
}

const wss = new WebSocket.Server({ port: PORT }, () => {
    console.log(`[ws] listening on :${PORT}`);
});

wss.on('connection', (ws) => {
    ws.id = randomUUID();
    ws.isAlive = true;
    ws.room = null;
    ws.isHost = false;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            return;
        }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'join') {
            const roomCode = (msg.room || '').toUpperCase().slice(0, 8) || 'DEFAULT';
            joinRoom(ws, { roomCode, mode: msg.mode, stage: msg.stage });
            return;
        }

        if (msg.type === 'matchmake') {
            const mode = msg.mode || 'ONLINE_VS';
            const stage = msg.stage || 'OCEAN';
            // Try to find a waiting player with the same mode
            let opponentIndex = matchQueue.findIndex(entry => entry.mode === mode && entry.ws.readyState === WebSocket.OPEN);
            if (opponentIndex >= 0) {
                const opponent = matchQueue.splice(opponentIndex, 1)[0];
                const roomCode = createRoomCode();
                joinRoom(opponent.ws, { roomCode, mode, stage: opponent.stage || stage });
                joinRoom(ws, { roomCode, mode, stage: opponent.stage || stage });
            } else {
                matchQueue.push({ ws, mode, stage });
                ws.send(JSON.stringify({ type: 'matching', mode, stage }));
            }
            return;
        }

        if (!ws.room) return;
        const room = ws.room;

        switch (msg.type) {
            case 'state':
                broadcast(room, { ...msg, playerId: ws.id }, ws.id);
                break;
            case 'action':
                // Relay fire/missile actions to everyone else
                broadcast(room, { ...msg, playerId: ws.id }, ws.id);
                break;
            case 'hit':
                broadcast(room, { ...msg, playerId: ws.id }, null);
                break;
            case 'enemySnapshot':
                if (ws.isHost) {
                    broadcast(room, { ...msg, playerId: ws.id }, ws.id);
                }
                break;
            default:
                break;
        }
    });

    ws.on('close', () => {
        // Remove from queue if waiting
        const idx = matchQueue.findIndex(entry => entry.ws === ws);
        if (idx >= 0) matchQueue.splice(idx, 1);

        if (ws.room) {
            const room = ws.room;
            room.clients.delete(ws.id);
            broadcast(room, { type: 'player-leave', playerId: ws.id, count: room.clients.size }, ws.id);
            // Promote a new host if needed
            if (ws.isHost) {
                const next = room.clients.keys().next();
                if (!next.done) {
                    const newHostId = next.value;
                    const newHost = room.clients.get(newHostId);
                    if (newHost) {
                        newHost.isHost = true;
                        newHost.send(JSON.stringify({ type: 'host-grant' }));
                    }
                }
            }
            if (room.clients.size === 0) {
                rooms.delete(room.code);
            }
        }
    });
});

// Heartbeat
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

process.on('SIGINT', () => {
    console.log('\n[ws] shutting down');
    wss.close(() => process.exit(0));
});

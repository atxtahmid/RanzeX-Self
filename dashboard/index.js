const express = require('express');
const path = require('path');
const fs = require('fs');
const QuestManager = require('../quests/manager');
const backup = require('../backup');
const app = express();

module.exports = (clients) => {
    const cookieParser = require('cookie-parser');
    app.use(cookieParser());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    app.use((req, res, next) => {
        if (!req.url.startsWith('/css') && !req.url.startsWith('/js') && !req.url.startsWith('/img')) {
            let activeKey = req.cookies.active_client || 'TOKEN';
            req.client = clients.find(c => c.tokenKey === activeKey);
            if (!req.client && clients.length > 0) req.client = clients[0];
            res.locals.clients = clients;
            res.locals.activeClientKey = req.client ? req.client.tokenKey : null;
            res.locals.clientUser = req.client ? req.client.user : null;
        }
        next();
    });

    app.post('/api/switch_client', (req, res) => {
        const { key } = req.body;
        if (clients.find(c => c.tokenKey === key)) {
            res.cookie('active_client', key, { maxAge: 30 * 24 * 60 * 60 * 1000 });
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    });

    const MULTI_QUEST_MANAGERS = new Map();

    function getQuestManager(tokenKey, token) {
        if (MULTI_QUEST_MANAGERS.has(tokenKey)) {
            return MULTI_QUEST_MANAGERS.get(tokenKey);
        }
        const mgr = new QuestManager(token);
        MULTI_QUEST_MANAGERS.set(tokenKey, mgr);
        return mgr;
    }

    for (const c of clients) {
        getQuestManager(c.tokenKey, c.token);
    }

    const port = process.env.PORT || 3000;

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    app.use(express.static(path.join(__dirname, 'public')));

    const failedLoginAttempts = new Map();
    const sessionKeyPath = path.join(__dirname, '..', 'data', 'dashboard_key.json');

    app.get('/login', (req, res) => {
        if (req.cookies.auth_token === 'valid_session') {
            if (fs.existsSync(sessionKeyPath)) {
                return res.redirect('/');
            } else {
                res.clearCookie('auth_token');
            }
        }
        res.render('login');
    });

    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body;
        const ip = req.ip;

        const record = failedLoginAttempts.get(ip);
        if (record && record.blockedUntil > Date.now()) {
            const remaining = Math.ceil((record.blockedUntil - Date.now()) / 1000 / 60);
            return res.json({ success: false, error: `Too many attempts. Blocked for ${remaining} mins.` });
        }

        const envUser = process.env.APP_USER || process.env.USERNAME;
        const envPass = process.env.APP_PASS || process.env.PASS;

        if (!envUser || !envPass) {
            return res.json({ success: false, error: 'Login setup missing in .env (APP_USER/APP_PASS).' });
        }

        let failed = false;

        if (username !== envUser || password !== envPass) {
            failed = true;
        }

        if (failed) {
            const r = record || { count: 0, blockedUntil: 0 };
            r.count++;
            if (r.count >= 3) {
                r.blockedUntil = Date.now() + 5 * 60 * 1000;
                r.count = 0;
            }
            failedLoginAttempts.set(ip, r);
            return res.json({ success: false, error: 'Invalid Credentials or Key.' });
        }

        failedLoginAttempts.delete(ip);

        try {
            fs.writeFileSync(sessionKeyPath, JSON.stringify({ key: 'disabled' }));
        } catch (e) {
            console.error('Failed to save session key:', e);
        }

        res.cookie('auth_token', 'valid_session', { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
        res.json({ success: true });
    });

    app.use((req, res, next) => {
        if (req.path === '/login' || req.path === '/api/login' || req.path.startsWith('/css') || req.path.startsWith('/js') || req.path.startsWith('/images')) {
            return next();
        }
        if (req.cookies.auth_token === 'valid_session' && fs.existsSync(sessionKeyPath)) {
            return next();
        }
        res.redirect('/login');
    });

    app.get('/logout', (req, res) => {
        if (fs.existsSync(sessionKeyPath)) {
            try { fs.unlinkSync(sessionKeyPath); } catch (e) { }
        }
        res.clearCookie('auth_token');
        res.redirect('/login');
    });

    app.get('/', (req, res) => {
        if (!req.client.user) {
            return res.send('Bot is not ready yet. Please refresh in a moment.');
        }

        const uptimeSeconds = Math.floor(req.client.uptime / 1000);

        const statusManager = require('../commands/statusManager');
        const statusData = statusManager.loadData(req.client);

        const status = statusData.status || 'online';
        const currentActivity = statusData.custom_status || '';
        const currentEmoji = statusData.emoji || '';

        res.render('index', {
            user: req.client.user,
            uptimeSeconds,
            status: status,
            currentActivity,
            currentEmoji,
            page: 'home'
        });
    });

    app.post('/update-status', async (req, res) => {
        try {
            const { status, custom_status, emoji } = req.body;

            const statusManager = require('../commands/statusManager');
            statusManager.saveData(req.client, {
                status: status,
                custom_status: custom_status,
                emoji: emoji
            });

            const rpcManager = require('../commands/rpcManager');
            await rpcManager.setPresence(req.client, rpcManager.loadData(req.client));

            if (req.xhr || req.headers.accept && req.headers.accept.indexOf('json') > -1) {
                return res.json({ success: true, message: 'Status updated!' });
            }

            res.redirect('/');
        } catch (error) {
            console.error(error);
            res.redirect('/?error=' + encodeURIComponent(error.message));
        }
    });

    app.get('/api/logs', (req, res) => {
        const logPath = path.join(__dirname, '..', 'data', 'afklog.json');
        if (fs.existsSync(logPath)) {
            const logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
            res.json(logs);
        } else {
            res.json([]);
        }
    });

    app.get('/quest', (req, res) => {
        if (!req.client.user) return res.send('Bot loading...');
        res.render('quest', {
            user: req.client.user,
            page: 'quest'
        });
    });

    app.post('/quest/start-all', (req, res) => {
        const mgr = getQuestManager(req.client.tokenKey, req.client.token);
        mgr.startAll();
        res.json({ success: true, message: 'Starting process...' });
    });

    app.post('/quest/stop-all', (req, res) => {
        const mgr = getQuestManager(req.client.tokenKey, req.client.token);
        mgr.stopAll();
        res.json({ success: true, message: 'All quests stopped.' });
    });

    app.post('/quest/clear-logs', (req, res) => {
        const mgr = getQuestManager(req.client.tokenKey, req.client.token);
        if (mgr.clearLogs) mgr.clearLogs();
        res.json({ success: true });
    });

    app.get('/api/quests', (req, res) => {
        const mgr = getQuestManager(req.client.tokenKey, req.client.token);
        res.json({
            logs: mgr.globalLogs,
            isRunning: mgr.isRunning
        });
    });

    app.get('/afk', (req, res) => {
        if (!req.client.user) return res.send('Bot loading...');

        const afkPath = path.join(__dirname, '..', 'data', 'afk.json');
        const logPath = path.join(__dirname, '..', 'data', 'afklog.json');

        let afkData = { isOn: false, reason: '' };
        let logs = [];

        if (fs.existsSync(afkPath)) afkData = JSON.parse(fs.readFileSync(afkPath, 'utf8'));
        if (fs.existsSync(logPath)) logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));

        res.render('afk', {
            user: req.client.user,
            afkData,
            logs,
            page: 'afk'
        });
    });

    app.post('/afk/save', (req, res) => {
        let { isOn, reason, logsEnabled } = req.body;
        const afkPath = path.join(__dirname, '..', 'data', 'afk.json');

        const checkBoolean = (val) => {
            if (Array.isArray(val)) return val.includes('on');
            return val === 'on';
        };

        const isAfkOn = checkBoolean(isOn);
        const isLogsOn = checkBoolean(logsEnabled);

        let existingData = {};
        if (fs.existsSync(afkPath)) existingData = JSON.parse(fs.readFileSync(afkPath, 'utf8'));

        const newData = {
            ...existingData,
            isOn: isAfkOn,
            reason: reason || existingData.reason || 'I am currently AFK.',
            logsEnabled: isLogsOn,
            startTime: isAfkOn ? Date.now() : (existingData.startTime || 0)
        };

        fs.writeFileSync(afkPath, JSON.stringify(newData, null, 2));

        if (req.xhr || req.headers.accept && req.headers.accept.indexOf('json') > -1) {
            return res.json({ success: true, message: 'Settings saved!' });
        }

        res.redirect('/afk');
    });

    app.post('/afk/clear-logs', (req, res) => {
        const { logId, clearAll } = req.body;
        const logPath = path.join(__dirname, '..', 'data', 'afklog.json');

        if (clearAll) {
            fs.writeFileSync(logPath, JSON.stringify([], null, 2));
        } else if (logId) {
            let logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
            logs = logs.filter(l => l.id !== logId);
            fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
        }

        res.redirect('/afk');
    });

    app.get('/commands', (req, res) => {
        if (!req.client.user) return res.send('Bot loading...');
        res.render('commands', {
            user: req.client.user,
            page: 'commands'
        });
    });

    app.get('/commands/rpc', (req, res) => {
        res.render('cmd_rpc', { user: req.client.user, page: 'commands' });
    });

    app.get('/api/rpc', (req, res) => {
        const rpcManager = require('../commands/rpcManager');
        res.json(rpcManager.loadData(req.client));
    });

    app.post('/api/rpc', async (req, res) => {
        const rpcManager = require('../commands/rpcManager');
        const data = req.body;
        rpcManager.saveData(req.client, data);
        await rpcManager.setPresence(req.client, data);
        res.json({ success: true });
    });

    app.get('/api/reaction', (req, res) => {
        const reactionManager = require('../commands/reactionManager');
        const data = reactionManager.loadData(req.client);

        const enrichedServers = (data.enabledServers || []).map(id => {
            const g = req.client.guilds.cache.get(id);
            return {
                id,
                name: g ? g.name : `Unknown Server`,
                icon: g ? g.iconURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png'
            };
        });

        const enrichedChannels = (data.enabledChannels || []).map(id => {
            const c = req.client.channels.cache.get(id);
            return {
                id,
                name: c ? c.name : `Unknown Channel`,
                guildName: c?.guild ? c.guild.name : 'Unknown Server',
                guildIcon: c?.guild ? c.guild.iconURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png'
            };
        });

        res.json({ ...data, enrichedServers, enrichedChannels });
    });

    app.post('/api/reaction', (req, res) => {
        const reactionManager = require('../commands/reactionManager');
        reactionManager.saveData(req.client, req.body);
        res.json({ success: true });
    });

    app.post('/api/validate/guild', async (req, res) => {
        const { id } = req.body;
        try {
            const guild = req.client.guilds.cache.get(id);
            if (!guild) return res.status(404).json({ error: 'Server not found (Bot must be in it)' });
            res.json({
                id: guild.id,
                name: guild.name,
                icon: guild.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png'
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/validate/channel', async (req, res) => {
        const { id } = req.body;
        try {
            const channel = req.client.channels.cache.get(id);
            if (!channel) return res.status(404).json({ error: 'Channel not found' });
            res.json({
                id: channel.id,
                name: channel.name,
                guildId: channel.guild?.id,
                guildName: channel.guild?.name || 'Direct Message',
                guildIcon: channel.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png'
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/ai', (req, res) => {
        res.render('cmd_ai', { user: req.client.user, page: 'ai' });
    });

    app.get('/api/ai', (req, res) => {
        const aiManager = require('../commands/aiManager');
        const data = aiManager.loadData(req.client);

        const enrichedServers = (data.enabledServers || []).map(id => {
            const g = req.client.guilds.cache.get(id);
            return { id, name: g ? g.name : 'Unknown Server', icon: g ? g.iconURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png' };
        });
        const enrichedChannels = (data.enabledChannels || []).map(id => {
            const c = req.client.channels.cache.get(id);
            return { id, name: c ? c.name : 'Unknown Channel', guildName: c?.guild?.name || 'Unknown', guildIcon: c?.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png' };
        });
        const enrichedGroupsAlways = (data.enabledGroups || []).map(id => {
            const c = req.client.channels.cache.get(id);
            let name = c ? c.name : 'Unknown Channel/Group';
            if (c && !name && c.recipients) name = c.recipients.map(u => u.username).join(', ');
            return { id, name, mode: 'always' };
        });
        const enrichedGroupsMention = (data.enabledGroupsMention || []).map(id => {
            const c = req.client.channels.cache.get(id);
            let name = c ? c.name : 'Unknown Channel/Group';
            if (c && !name && c.recipients) name = c.recipients.map(u => u.username).join(', ');
            return { id, name, mode: 'mention' };
        });
        const enrichedGroups = [...enrichedGroupsAlways, ...enrichedGroupsMention];

        const enrichedFreeWill = (data.freeWillChannels || []).map(item => {
            const id = typeof item === 'object' ? item.id : item;
            const delay = typeof item === 'object' ? item.delay : 0;
            const c = req.client.channels.cache.get(id);
            return { id, delay, name: c ? c.name : 'Unknown Channel', guildName: c?.guild?.name || 'Unknown', guildIcon: c?.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png' };
        });
        const enrichedUsers = (data.dmUsers || []).map(id => {
            const u = req.client.users.cache.get(id);
            return { id, username: u ? u.username : 'Unknown User', avatar: u ? u.displayAvatarURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png' };
        });

        const enrichedBlockedUsers = (data.blockedUsers || []).map(id => {
            const u = req.client.users.cache.get(id);
            return { id, username: u ? u.username : 'Unknown User', avatar: u ? u.displayAvatarURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png' };
        });

        res.json({ ...data, enrichedServers, enrichedChannels, enrichedGroups, enrichedFreeWill, enrichedUsers, enrichedBlockedUsers });
    });

    app.post('/api/ai', (req, res) => {
        const aiManager = require('../commands/aiManager');
        aiManager.saveData(req.client, req.body);
        res.json({ success: true });
    });

    app.post('/api/validate/user', async (req, res) => {
        const { id } = req.body;
        try {
            const user = await req.client.users.fetch(id).catch(() => null);
            if (!user) return res.status(404).json({ error: 'User not found' });
            res.json({
                id: user.id,
                username: user.username,
                avatar: user.displayAvatarURL({ dynamic: true })
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/validate/mixed', async (req, res) => {
        const { id } = req.body;
        try {
            const channel = await req.client.channels.fetch(id).catch(() => null);
            if (channel) {
                if (!channel.isText()) return res.status(400).json({ error: 'Channel is not a text channel' });
                return res.json({
                    type: 'channel',
                    id: channel.id,
                    name: channel.name,
                    guildName: channel.guild?.name || 'DM',
                    icon: channel.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png'
                });
            }

            const user = await req.client.users.fetch(id).catch(() => null);
            if (user) {
                return res.json({
                    type: 'user',
                    id: user.id,
                    name: user.username,
                    guildName: 'Direct Message',
                    icon: user.displayAvatarURL({ dynamic: true })
                });
            }

            res.status(404).json({ error: 'ID not found (Must be Channel or User)' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/commands/reaction', (req, res) => {
        res.render('cmd_reaction', { user: req.client.user, page: 'commands' });
    });
    app.get('/commands/mirror', (req, res) => {
        res.render('cmd_mirror', { user: req.client.user, page: 'commands' });
    });
    app.get('/commands/clipboard', (req, res) => {
        res.render('cmd_clipboard', { user: req.client.user, page: 'commands' });
    });

    app.get('/commands/auto-msg', (req, res) => {
        res.render('cmd_auto_msg', { user: req.client.user, page: 'commands' });
    });

    app.get('/api/auto-msg', (req, res) => {
        const autoMsg = require('../commands/autoMsg');
        res.json(autoMsg.getList(req.client));
    });

    app.post('/api/auto-msg', async (req, res) => {
        const autoMsg = require('../commands/autoMsg');
        const { action, channelId, message, interval, unit } = req.body;

        try {
            if (action === 'add') {
                await autoMsg.startTimer(req.client, channelId, message, interval, unit);
                autoMsg.addAutoMsg(req.client, channelId, message, interval, unit);
            } else if (action === 'remove') {
                autoMsg.removeAutoMsg(req.client, channelId);
            }
            res.json({ success: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.get('/commands/timed-msg', (req, res) => {
        res.render('cmd_timed_msg', { user: req.client.user, page: 'commands' });
    });

    app.get('/api/timed-msg', (req, res) => {
        const timedMsg = require('../commands/timedMsg');
        res.json(timedMsg.getList(req.client));
    });

    app.post('/api/timed-msg', async (req, res) => {
        const timedMsg = require('../commands/timedMsg');
        const { action, id, channelId, message, timestamp, timezone } = req.body;

        try {
            if (action === 'add') {
                const item = timedMsg.addTimedMsg(req.client, channelId, message, timestamp, timezone);
                res.json({ success: true, item });
            } else if (action === 'remove') {
                timedMsg.removeTimedMsg(req.client, id);
                res.json({ success: true });
            } else {
                res.status(400).json({ error: 'Invalid action' });
            }
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.get('/api/clipboard', (req, res) => {
        const clipboardManager = require('../commands/clipboardManager');
        res.json(clipboardManager.loadData(req.client));
    });

    app.post('/api/clipboard', (req, res) => {
        const clipboardManager = require('../commands/clipboardManager');
        const { action, trigger, response } = req.body;

        if (action === 'add') {
            clipboardManager.addTrigger(req.client, trigger, response);
        } else if (action === 'remove') {
            clipboardManager.removeTrigger(req.client, trigger);
        }
        res.json({ success: true });
    });

    app.get('/commands/allowed', (req, res) => {
        res.render('cmd_allowed', { user: req.client.user, page: 'commands' });
    });

    app.get('/api/allowed', async (req, res) => {
        const allowedManager = require('../commands/allowedManager');
        const data = allowedManager.loadData(req.client);

        const enrichedUsers = await Promise.all(data.allowedUsers.map(async (id) => {
            const u = await req.client.users.fetch(id).catch(() => null);
            return {
                id,
                username: u ? u.username : 'Unknown User',
                avatar: u ? u.displayAvatarURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png'
            };
        }));

        res.json({ allowedUsers: enrichedUsers });
    });

    app.post('/api/allowed', (req, res) => {
        const { action, id } = req.body;
        const allowedManager = require('../commands/allowedManager');

        if (action === 'add') {
            allowedManager.addAllowedUser(req.client, id);
        } else if (action === 'remove') {
            allowedManager.removeAllowedUser(req.client, id);
        }
        res.json({ success: true });
    });

    app.get('/api/mirror', (req, res) => {
        const mirrorManager = require('../commands/mirrorManager');
        const list = mirrorManager.getActiveMirrors(req.client) || [];
        const enriched = list.map(m => {
            const s = req.client.channels.cache.get(m.sourceId);
            const t = req.client.channels.cache.get(m.targetId);
            return {
                ...m,
                sourceName: s ? `#${s.name} (${s.guild?.name || 'DM'})` : m.sourceId,
                targetName: t ? `#${t.name} (${t.guild?.name || 'DM'})` : m.targetId,
                sourceIcon: s?.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png',
                targetIcon: t?.guild?.iconURL({ dynamic: true }) || 'https://cdn.discordapp.com/embed/avatars/0.png'
            };
        });
        res.json(enriched);
    });

    app.post('/api/mirror', async (req, res) => {
        const { sourceId, targetId, mode } = req.body;
        const mirrorManager = require('../commands/mirrorManager');
        try {
            await mirrorManager.startMirror(req.client, sourceId, targetId, mode);
            res.json({ success: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.delete('/api/mirror', async (req, res) => {
        const { sourceId } = req.body;
        const mirrorManager = require('../commands/mirrorManager');
        await mirrorManager.stopMirror(req.client, sourceId);
        res.json({ success: true });
    });

    app.post('/api/validate/mirror-channel', async (req, res) => {
        const { id, checkWebhook } = req.body;
        try {
            const channel = await req.client.channels.fetch(id).catch(() => null);
            if (!channel) return res.status(404).json({ error: 'Channel not found/Not Visible' });

            if (!channel.isText()) return res.status(400).json({ error: 'Not a text channel' });

            if (channel.guild) {
                const permissions = channel.permissionsFor(req.client.user);

                const { type } = req.body;
                if (type === 'target') {
                    if (!permissions.has('SEND_MESSAGES')) return res.status(403).json({ error: 'Missing SEND_MESSAGES permission' });
                } else {
                    if (!permissions.has('VIEW_CHANNEL')) return res.status(403).json({ error: 'Missing VIEW_CHANNEL permission' });
                }

                if (checkWebhook) {
                    if (!permissions.has('MANAGE_WEBHOOKS')) return res.status(403).json({ error: 'Missing MANAGE_WEBHOOKS permission (Required for Clone)' });
                }
            } else {
                if (checkWebhook) return res.status(400).json({ error: 'Clone Mode (Webhooks) not supported in DMs' });
            }

            res.json({
                success: true,
                name: channel.name || 'DM',
                guildName: channel.guild?.name || 'Direct Message',
                icon: channel.guild?.iconURL({ dynamic: true }) || channel.recipient?.displayAvatarURL({ dynamic: true })
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/commands/welcomer', (req, res) => {
        res.render('cmd_welcomer', { user: req.client.user, page: 'commands' });
    });

    app.get('/api/welcomer', async (req, res) => {
        const welcomerManager = require('../commands/welcomerManager');
        const data = welcomerManager.loadData(req.client);
        const setups = data.welcomeSetups || {};

        const enrichedList = [];
        for (const [guildId, val] of Object.entries(setups)) {
            const guild = req.client.guilds.cache.get(guildId);
            let channelName = "Unknown Channel";
            if (guild) {
                const c = guild.channels.cache.get(val.channelId);
                if (c) channelName = c.name;
            }

            enrichedList.push({
                guildId,
                guildName: guild ? guild.name : `Server ${guildId}`,
                icon: guild && guild.iconURL() ? guild.iconURL({ dynamic: true }) : 'https://cdn.discordapp.com/embed/avatars/0.png',
                channelId: val.channelId,
                channelName: channelName,
                template: val.template,
                background: val.background,
                textcolor: val.textcolor,
                welcomeType: val.welcomeType || 'card',
                textMessage: val.textMessage || 'hey {user} welcome to the {server} you are {count} member',
                cardMessage: val.cardMessage || 'WELCOME TO {server}\n{user}\nMember #{count}'
            });
        }
        const config = data.config || { textcolor: 'white', welcomeType: 'card', textMessage: 'hey {user} welcome to the {server} you are {count} member', cardMessage: 'WELCOME TO {server}\n{user}\nMember #{count}' };
        res.json({ setups: enrichedList, config });
    });

    app.post('/api/welcomer', (req, res) => {
        const welcomerManager = require('../commands/welcomerManager');
        const { action, guildId, channelId, template, background, textcolor, welcomeType, textMessage, cardMessage } = req.body;

        try {
            if (action === 'add') {
                welcomerManager.addSetup(req.client, guildId, channelId, template, background, textcolor, welcomeType, textMessage, cardMessage);
            } else if (action === 'remove') {
                welcomerManager.removeSetup(req.client, guildId);
            } else if (action === 'saveConfig') {
                const data = welcomerManager.loadData(req.client);
                data.config = { textcolor, welcomeType, textMessage, cardMessage };

                if (!data.welcomeSetups) data.welcomeSetups = {};
                for (let gid of Object.keys(data.welcomeSetups)) {
                    data.welcomeSetups[gid].textcolor = textcolor;
                    data.welcomeSetups[gid].welcomeType = welcomeType;
                    data.welcomeSetups[gid].textMessage = textMessage;
                    data.welcomeSetups[gid].cardMessage = cardMessage;
                }
                welcomerManager.saveData(req.client, data);
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/commands/recorder', (req, res) => {
        res.render('cmd_recorder', { user: req.client.user, page: 'commands' });
    });

    app.get('/api/recorder/status', (req, res) => {
        const recManager = require('../commands/rec');
        const { getVoiceConnection } = require('@discordjs/voice');
        let recordingStatus = false;
        let recordingTime = 0;
        let activeGuildId = null;
        let channelId = null;
        let guildName = '';
        let channelName = '';
        let guildIcon = '';

        for (const [gid, session] of recManager.activeSessions.entries()) {
            activeGuildId = gid;
            channelId = session.channelId;
            guildName = session.guildName;
            channelName = session.channelName;
            const g = req.client.guilds.cache.get(gid);
            guildIcon = g ? g.iconURL({ dynamic: true }) : '';
            recordingStatus = true;
            recordingTime = Date.now() - session.recordingStartTime;
            break;
        }

        if (!activeGuildId) {
            for (const [gId, guild] of req.client.guilds.cache.entries()) {
                const member = guild.members.cache.get(req.client.user.id);
                if (member && member.voice && member.voice.channelId) {
                    activeGuildId = gId;
                    channelId = member.voice.channelId;
                    guildName = guild.name;
                    channelName = member.voice.channel.name;
                    guildIcon = guild.iconURL({ dynamic: true }) || '';
                    break;
                }
            }
        }

        res.json({
            isConnectedToVoice: !!activeGuildId,
            isPlayingRecording: recManager.playbackPlayers.has(activeGuildId),
            isRecording: recordingStatus,
            activeGuildId,
            channelId,
            guildName,
            channelName,
            guildIcon,
            recordingTime,
            recordings: recManager.loadMeta()
        });
    });

    app.post('/api/recorder/join', async (req, res) => {
        const recManager = require('../commands/rec');
        try {
            await recManager.joinTargetVC(req.client, req.body.guildId, req.body.channelId);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/recorder/leave', (req, res) => {
        const { getVoiceConnection } = require('@discordjs/voice');
        const conn = getVoiceConnection(req.body.guildId);
        if (conn) {
            try { conn.destroy(); } catch (e) { }
        }
        res.json({ success: true });
    });

    app.post('/api/recorder/start', async (req, res) => {
        const recManager = require('../commands/rec');
        try {
            await recManager.startRecordingDirect(req.client, req.body.guildId, req.body.channelId, "Dashboard");
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/recorder/stop', async (req, res) => {
        const recManager = require('../commands/rec');
        try {
            await recManager.stopRecordingDirect(req.client, req.body.guildId);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/recorder/play', async (req, res) => {
        const recManager = require('../commands/rec');
        try {
            await recManager.playRecordingDirect(req.client, req.body.guildId, req.body.filename);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/recorder/stopplay', (req, res) => {
        const recManager = require('../commands/rec');
        try {
            recManager.stopPlaybackDirect(req.body.guildId);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/recorder/delete', (req, res) => {
        const recManager = require('../commands/rec');
        try {
            recManager.deleteRecordingDirect(req.body.filename);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    const joiner = require('../commands/joinserver');

    app.get('/commands/joiner', (req, res) => {
        res.render('cmd_joiner', { user: req.client.user, page: 'commands' });
    });

    app.post('/api/join-server/preview', async (req, res) => {
        const { invite } = req.body;
        if (!invite) return res.status(400).json({ success: false, error: 'Missing invite' });

        const code = joiner.extractInviteCode(invite);
        if (!code) return res.status(400).json({ success: false, error: 'Invalid invite format' });

        try {
            const result = await joiner.previewInvite(req.client, code);

            if (result.status === 404) {
                return res.json({ success: false, error: 'Invite not found or expired' });
            }
            if (result.status === 429) {
                return res.json({ success: false, error: `Rate limited. Try again in ${Math.ceil(result.data.retry_after || 5)}s` });
            }
            if (result.status !== 200) {
                return res.json({ success: false, error: result.data.message || `HTTP ${result.status}` });
            }

            const guild = result.data.guild;
            const iconUrl = guild?.icon
                ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
                : 'https://cdn.discordapp.com/embed/avatars/0.png';

            res.json({
                success: true,
                code,
                guild: {
                    id: guild?.id || 'N/A',
                    name: guild?.name || 'Unknown',
                    icon: iconUrl,
                    memberCount: result.data.approximate_member_count || '?',
                    onlineCount: result.data.approximate_presence_count || '?'
                }
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/join-server/join', async (req, res) => {
        const { invite } = req.body;
        if (!invite) return res.status(400).json({ success: false, error: 'Missing invite' });

        const code = joiner.extractInviteCode(invite);
        if (!code) return res.status(400).json({ success: false, error: 'Invalid invite format' });

        try {
            const result = await joiner.joinInvite(req.client, code);

            if (result.status === 200) {
                return res.json({
                    success: true,
                    guild: { id: result.data.guild?.id, name: result.data.guild?.name }
                });
            }

            if (result.status === 429) {
                return res.json({ success: false, error: `Rate limited. Try again in ${Math.ceil(result.data.retry_after || 5)}s` });
            }

            const msg = result.data.message || `HTTP ${result.status}`;
            res.json({ success: false, error: msg });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/commands/channels', (req, res) => {
        res.render('cmd_channels', { user: req.client.user, page: 'commands' });
    });

    app.get('/api/channels/guilds', (req, res) => {
        try {
            const guilds = req.client.guilds.cache
                .filter(g => {
                    const member = g.members.cache.get(req.client.user.id);
                    return member ? member.permissions.has('MANAGE_CHANNELS') : false;
                })
                .map(g => ({
                    id: g.id,
                    name: g.name,
                    icon: g.iconURL({ dynamic: true, size: 64 }) || 'https://cdn.discordapp.com/embed/avatars/0.png'
                }));
            res.json(guilds);
        } catch (e) {
            res.json([]);
        }
    });

    app.get('/api/channels/:guildId', async (req, res) => {
        try {
            const guild = req.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json({ error: 'Guild not found' });

            const member = guild.members.cache.get(req.client.user.id) || await guild.members.fetch(req.client.user.id).catch(() => null);
            const canManage = member ? member.permissions.has('MANAGE_CHANNELS') : false;
            if (!canManage) return res.status(403).json({ error: 'Missing MANAGE_CHANNELS permission' });

            const channels = guild.channels.cache.map(c => ({
                id: c.id,
                name: c.name,
                type: c.type,
                position: c.position,
                parentId: c.parentId,
                parentName: c.parent ? c.parent.name : null,
                nsfw: c.nsfw || false,
                deletable: c.deletable
            })).sort((a, b) => a.position - b.position);

            const categories = guild.channels.cache
                .filter(c => c.type === 'GUILD_CATEGORY')
                .map(c => ({ id: c.id, name: c.name }))
                .sort((a, b) => a.name.localeCompare(b.name));

            res.json({ channels, categories, canManage });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/channels/create', async (req, res) => {
        try {
            const { guildId, name, type, nsfw, privacy, parentId, topic } = req.body;
            if (!guildId || !name) return res.status(400).json({ error: 'Missing guildId or name' });

            const guild = req.client.guilds.cache.get(guildId);
            if (!guild) return res.status(404).json({ error: 'Guild not found' });

            const permissionOverwrites = [];
            if (privacy === 'private') {
                permissionOverwrites.push({
                    id: guild.roles.everyone.id,
                    deny: ['VIEW_CHANNEL']
                });
            }

            const createOptions = {
                name: name.trim(),
                type: type || 'GUILD_TEXT',
                permissionOverwrites,
                reason: 'Dashboard - Channel Creator'
            };

            if (parentId) createOptions.parent = parentId;

            if (type === 'GUILD_TEXT' || type === 'GUILD_NEWS') {
                if (typeof nsfw === 'boolean') createOptions.nsfw = nsfw;
                if (topic) createOptions.topic = topic;
            }

            const channel = await guild.channels.create(createOptions.name, createOptions);

            res.json({
                success: true,
                channel: { id: channel.id, name: channel.name, type: channel.type }
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/channels/delete', async (req, res) => {
        try {
            const { guildId, channelIds } = req.body;
            if (!guildId || !Array.isArray(channelIds) || channelIds.length === 0) {
                return res.status(400).json({ error: 'Missing guildId or channelIds' });
            }

            const guild = req.client.guilds.cache.get(guildId);
            if (!guild) return res.status(404).json({ error: 'Guild not found' });

            const results = { deleted: [], failed: [] };

            for (const id of channelIds) {
                const channel = guild.channels.cache.get(id);
                if (!channel) {
                    results.failed.push({ id, reason: 'Not found' });
                    continue;
                }
                if (!channel.deletable) {
                    results.failed.push({ id, name: channel.name, reason: 'Not deletable' });
                    continue;
                }
                try {
                    await channel.delete('Dashboard - Channel Deleter');
                    results.deleted.push({ id, name: channel.name });
                    await new Promise(r => setTimeout(r, 800));
                } catch (e) {
                    results.failed.push({ id, name: channel.name, reason: e.message });
                }
            }

            res.json({ success: true, ...results });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/tokens/validate', async (req, res) => {
        const { token } = req.body;
        if (!token || typeof token !== 'string' || token.length < 30) {
            return res.json({ success: false, error: 'Invalid token format' });
        }

        try {
            const { fetch } = require('undici');
            const r = await fetch('https://discord.com/api/v9/users/@me', {
                headers: {
                    'Authorization': token.trim(),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36'
                }
            });

            if (r.status !== 200) {
                return res.json({ success: false, error: 'Invalid token (Discord rejected it)' });
            }

            const user = await r.json();
            res.json({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    discriminator: user.discriminator,
                    global_name: user.global_name,
                    avatar: user.avatar
                        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
                        : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discriminator || 0) % 5}.png`
                }
            });
        } catch (e) {
            res.json({ success: false, error: 'Network error: ' + e.message });
        }
    });

    app.post('/api/tokens/add', async (req, res) => {
        const { token } = req.body;
        if (!token || typeof token !== 'string' || token.length < 30) {
            return res.json({ success: false, error: 'Invalid token' });
        }

        const cleanToken = token.trim();

        const existing = clients.find(c => c.token === cleanToken);
        if (existing) {
            return res.json({
                success: true,
                alreadyExists: true,
                key: existing.tokenKey,
                message: 'Token already loaded'
            });
        }

        const usedKeys = clients.map(c => c.tokenKey);
        let nextKey = 'TOKEN2';
        let n = 2;
        while (usedKeys.includes(nextKey) && n < 100) {
            n++;
            nextKey = 'TOKEN' + n;
        }

        try {
            global.totalTokens++;
            global.setupClient({ key: nextKey, token: cleanToken }, 0);

            const deadline = Date.now() + 30000;
            let newClient = null;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 1000));
                newClient = global.clients.find(c => c.tokenKey === nextKey);
                if (newClient && newClient.user) break;
            }

            if (!newClient || !newClient.user) {
                const idx = global.clients.findIndex(c => c.tokenKey === nextKey);
                if (idx !== -1) {
                    try { global.clients[idx].destroy(); } catch (e) { }
                    global.clients.splice(idx, 1);
                }
                global.totalTokens--;
                return res.json({ success: false, error: 'Login timeout (30s). Token may be invalid or Discord rate-limited the login.' });
            }

            getQuestManager(nextKey, cleanToken);
            backup.addStoredToken(nextKey, cleanToken);

            res.json({
                success: true,
                key: nextKey,
                user: {
                    id: newClient.user.id,
                    username: newClient.user.username,
                    discriminator: newClient.user.discriminator,
                    avatar: newClient.user.displayAvatarURL({ dynamic: true, size: 128 })
                }
            });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    app.post('/api/tokens/remove', async (req, res) => {
        const { key } = req.body;
        if (!key || typeof key !== 'string') {
            return res.json({ success: false, error: 'Missing token key' });
        }

        if (key === 'TOKEN') {
            return res.json({ success: false, error: 'Cannot remove the main TOKEN (from env). Remove it from Railway Variables instead.' });
        }

        const envKeys = Object.keys(process.env).filter(k => k === 'TOKEN' || /^TOKEN\d+$/.test(k));
        if (envKeys.includes(key)) {
            return res.json({ success: false, error: `${key} is set via Railway env variables. Remove it from the Railway Variables tab.` });
        }

        const client = clients.find(c => c.tokenKey === key);
        if (!client) {
            backup.removeStoredToken(key);
            return res.json({ success: true, message: 'Removed from storage' });
        }

        try {
            if (MULTI_QUEST_MANAGERS.has(key)) {
                const mgr = MULTI_QUEST_MANAGERS.get(key);
                try { mgr.stopAll(); } catch (e) { }
                MULTI_QUEST_MANAGERS.delete(key);
            }

            try { client.destroy(); } catch (e) { }

            const idx = global.clients.findIndex(c => c.tokenKey === key);
            if (idx !== -1) global.clients.splice(idx, 1);
            if (global.totalTokens > 0) global.totalTokens--;

            backup.removeStoredToken(key);

            res.json({ success: true, removed: key });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/commands/:category', (req, res) => {
        const category = req.params.category;
        res.render('commands_sub', {
            user: req.client.user,
            page: 'commands',
            category: category.charAt(0).toUpperCase() + category.slice(1)
        });
    });

    app.get('/music', (req, res) => {
        if (!req.client.user) return res.send('Bot loading...');
        res.render('music', {
            user: req.client.user,
            page: 'music'
        });
    });

    app.get('/api/music/status', (req, res) => {
        const queues = req.client.queueManager ? req.client.queueManager.getAll() : new Map();

        const getCover = (info) => {
            if (info.sourceName === 'youtube' || info.uri.includes('youtube')) {
                return `https://img.youtube.com/vi/${info.identifier}/maxresdefault.jpg`;
            } else if (info.artworkUrl) {
                return info.artworkUrl;
            }
            return 'https://i.imgur.com/2ce2t5e.png';
        };

        let musicData = {
            connected: !!req.client.lavalink,
            isPlaying: false,
            guildName: 'No Guild',
            guildIcon: null,
            channelName: '',
            nowPlaying: null,
            position: 0,
            duration: 0,
            volume: 100,
            loop: 'none',
            autoplay: false,
            queue: [],
            queueCount: 0
        };

        for (const [guildId, queue] of queues) {
            if (queue.nowPlaying) {
                const guild = req.client.guilds.cache.get(guildId);
                const voiceState = req.client.lavalinkVoiceStates ? req.client.lavalinkVoiceStates[guildId] : null;

                musicData.activeGuildId = guildId;
                musicData.isPlaying = true;
                musicData.guildName = guild ? guild.name : `Guild ${guildId}`;
                musicData.guildIcon = guild ? guild.iconURL({ dynamic: true, size: 128 }) : null;
                musicData.volume = queue.volume !== undefined ? queue.volume : 100;
                musicData.loop = queue.loop || 'none';
                musicData.autoplay = queue.autoplay || false;

                if (guild && guild.me && guild.me.voice && guild.me.voice.channel) {
                    musicData.channelName = guild.me.voice.channel.name;
                }

                const info = queue.nowPlaying.info;
                let cover = 'https://i.imgur.com/2ce2t5e.png';

                if (info.sourceName === 'youtube' || info.uri.includes('youtube')) {
                    cover = `https://img.youtube.com/vi/${info.identifier}/maxresdefault.jpg`;
                } else if (info.artworkUrl) {
                    cover = info.artworkUrl;
                }

                musicData.nowPlaying = {
                    title: info.title,
                    author: info.author,
                    cover: cover,
                    url: info.uri
                };

                musicData.duration = info.length;
                musicData.position = queue.position || 0;

                if (queue.lastUpdate && !queue.paused) {
                    const diff = Date.now() - queue.lastUpdate;
                    musicData.position += diff;
                    if (musicData.position > musicData.duration) musicData.position = musicData.duration;
                }

                musicData.queue = queue.songs.map(song => ({
                    title: song.info.title,
                    author: song.info.author,
                    uri: song.info.uri,
                    cover: getCover(song.info)
                }));
                musicData.queueCount = queue.songs.length;
                break;
            }
        }

        if (!musicData.isPlaying) {
            for (const [id, guild] of req.client.guilds.cache) {
                if (guild.me && guild.me.voice && guild.me.voice.channelId) {
                    musicData.activeGuildId = id;
                    musicData.isConnectedToVoice = true;
                    musicData.guildName = guild.name;
                    musicData.guildIcon = guild.iconURL ? guild.iconURL({ dynamic: true, size: 128 }) : null;
                    if (guild.me.voice.channel) musicData.channelName = guild.me.voice.channel.name;
                    break;
                }
            }
        }

        res.json(musicData);
    });

    app.post('/api/music/stop', async (req, res) => {
        try {
            const queues = req.client.queueManager ? req.client.queueManager.getAll() : new Map();
            let stopped = false;

            for (const [guildId, queue] of queues) {
                if (queue.nowPlaying) {
                    if (req.client.lavalink) {
                        await req.client.lavalink.destroyPlayer(guildId);
                    }
                    req.client.queueManager.delete(guildId);

                    const { getVoiceConnection } = require('@discordjs/voice');
                    const connection = getVoiceConnection(guildId);
                    if (connection) {
                        connection.destroy();
                    }

                    stopped = true;
                }
            }

            if (stopped) {
                res.json({ success: true, message: 'Music stopped' });
            } else {
                res.json({ success: false, message: 'No music is playing' });
            }
        } catch (error) {
            console.error('Error stopping music:', error);
            res.json({ success: false, message: error.message });
        }
    });

    app.post('/api/music/skip', async (req, res) => {
        try {
            const queues = req.client.queueManager ? req.client.queueManager.getAll() : new Map();
            for (const [guildId, queue] of queues) {
                if (queue.nowPlaying) {
                    if (queue.autoplay && queue.songs.length < 5) await req.client.queueManager.fillAutoplayQueue(req.client, guildId);
                    const nextSong = req.client.queueManager.getNext(guildId);

                    if (!nextSong) {
                        if (req.client.lavalink) await req.client.lavalink.destroyPlayer(guildId);
                        req.client.queueManager.delete(guildId);
                    } else {
                        if (queue.nowPlaying) queue.history.push(queue.nowPlaying);
                        queue.nowPlaying = nextSong;
                        queue.position = 0;
                        queue.lastUpdate = Date.now();
                        await req.client.lavalink.updatePlayer(guildId, nextSong, req.client.lavalinkVoiceStates[guildId] || {});
                    }
                    return res.json({ success: true });
                }
            }
            res.json({ success: false, message: 'No music playing' });
        } catch (e) { console.error(e); res.json({ success: false }); }
    });

    app.post('/api/music/previous', async (req, res) => {
        try {
            const queues = req.client.queueManager ? req.client.queueManager.getAll() : new Map();
            for (const [guildId, queue] of queues) {
                if (queue.nowPlaying && queue.history.length > 0) {
                    const prev = queue.history.pop();
                    queue.songs.unshift(queue.nowPlaying);
                    queue.nowPlaying = prev;
                    queue.position = 0;
                    queue.lastUpdate = Date.now();
                    await req.client.lavalink.updatePlayer(guildId, prev, req.client.lavalinkVoiceStates[guildId] || {});
                    return res.json({ success: true });
                }
            }
            res.json({ success: false, message: 'No previous song' });
        } catch (e) { console.error(e); res.json({ success: false }); }
    });

    app.post('/api/music/volume', async (req, res) => {
        const { guildId, volume } = req.body;
        try {
            const queue = req.client.queueManager ? req.client.queueManager.get(guildId) : null;
            if (queue && req.client.lavalink) {
                const vol = parseInt(volume);
                if (!isNaN(vol) && vol >= 0 && vol <= 500) {
                    queue.volume = vol;
                    await req.client.lavalink.updatePlayerProperties(guildId, { volume: vol });
                    return res.json({ success: true, volume: vol });
                }
            }
            res.json({ success: false, message: 'No active player or invalid volume' });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/music/loop', async (req, res) => {
        const { guildId } = req.body;
        try {
            const queue = req.client.queueManager ? req.client.queueManager.get(guildId) : null;
            if (queue && req.client.lavalink) {
                if (queue.loop === 'none') queue.loop = 'track';
                else if (queue.loop === 'track') queue.loop = 'queue';
                else if (queue.loop === 'queue') queue.loop = 'none';
                return res.json({ success: true, loop: queue.loop });
            }
            res.json({ success: false, message: 'No active player' });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/music/autoplay', async (req, res) => {
        const { guildId } = req.body;
        try {
            const queue = req.client.queueManager ? req.client.queueManager.get(guildId) : null;
            if (queue && req.client.lavalink) {
                queue.autoplay = !queue.autoplay;
                if (queue.autoplay) {
                    await req.client.queueManager.fillAutoplayQueue(req.client, guildId);
                }
                return res.json({ success: true, autoplay: queue.autoplay });
            }
            res.json({ success: false, message: 'No active player' });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/music/seek', async (req, res) => {
        const { guildId, amount } = req.body;
        try {
            const queue = req.client.queueManager ? req.client.queueManager.get(guildId) : null;
            if (queue && req.client.lavalink && queue.nowPlaying) {
                let newPosition = queue.position + amount;

                if (newPosition < 0) newPosition = 0;
                if (newPosition > queue.nowPlaying.info.length) {
                    newPosition = queue.nowPlaying.info.length - 1000;
                    if (newPosition < 0) newPosition = 0;
                }

                await req.client.lavalink.updatePlayerProperties(guildId, { position: newPosition });
                queue.position = newPosition;
                queue.lastUpdate = Date.now();
                return res.json({ success: true, position: newPosition });
            }
            res.json({ success: false, message: 'No active player' });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/music/playlists', (req, res) => {
        try {
            const pltPath = path.join(__dirname, '../data/playlists.json');
            if (fs.existsSync(pltPath)) {
                const data = JSON.parse(fs.readFileSync(pltPath, 'utf8'));
                res.json({ success: true, playlists: Object.keys(data) });
            } else {
                res.json({ success: true, playlists: [] });
            }
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    app.post('/api/music/playlist/load', async (req, res) => {
        const { guildId, name } = req.body;
        try {
            const pltPath = path.join(__dirname, '../data/playlists.json');
            if (!fs.existsSync(pltPath)) return res.json({ success: false, message: 'No playlists found' });

            const data = JSON.parse(fs.readFileSync(pltPath, 'utf8'));
            const playlist = data[name];
            if (!playlist || playlist.length === 0) return res.json({ success: false, message: 'Playlist not found or empty' });

            const voiceState = req.client.lavalinkVoiceStates ? req.client.lavalinkVoiceStates[guildId] : null;
            if (!voiceState || !voiceState.token) {
                return res.json({ success: false, message: 'Bot not connected to voice in this server' });
            }

            let queue = req.client.queueManager ? req.client.queueManager.get(guildId) : null;
            if (!queue) {
                queue = req.client.queueManager.create(guildId);
            }

            let added = 0;
            for (const song of playlist) {
                try {
                    const lRes = await req.client.lavalink.loadTracks(song.uri);
                    let trackToLoad;

                    if (lRes.loadType === 'track') trackToLoad = lRes.data;
                    else if (lRes.loadType === 'playlist') trackToLoad = lRes.data.tracks[0];
                    else if (lRes.loadType === 'search') trackToLoad = lRes.data[0];

                    if (trackToLoad) {
                        req.client.queueManager.addSong(guildId, trackToLoad);
                        added++;
                    }
                } catch (e) {
                    console.error('Error loading fav track:', e);
                }
            }

            if (added > 0 && !queue.nowPlaying && req.client.queueManager) {
                const nextSong = req.client.queueManager.getNext(guildId);
                if (nextSong) {
                    queue.nowPlaying = nextSong;
                    await req.client.lavalink.updatePlayer(guildId, nextSong, voiceState, {
                        volume: queue.volume,
                        filters: queue.filters
                    });
                }
            }

            if (queue && queue.autoplay && queue.songs.length < 5) {
                await req.client.queueManager.fillAutoplayQueue(req.client, guildId);
            }

            res.json({ success: true, added });
        } catch (e) {
            console.error('Playlist load API error:', e);
            res.json({ success: false, message: e.message });
        }
    });

    app.get('/api/discord/guilds', (req, res) => {
        try {
            const guilds = req.client.guilds.cache.map(g => ({ id: g.id, name: g.name, icon: g.iconURL() }));
            res.json(guilds);
        } catch (e) { res.json([]); }
    });

    app.get('/api/discord/channels/:guildId', (req, res) => {
        try {
            const guild = req.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.json([]);
            const channels = guild.channels.cache
                .filter(c => c.type === 'GUILD_VOICE' || c.type === 'GUILD_STAGE_VOICE')
                .map(c => ({ id: c.id, name: c.name }));
            res.json(channels);
        } catch (e) { res.json([]); }
    });

    app.post('/api/music/join', async (req, res) => {
        const { guildId, channelId } = req.body;
        try {
            const payload = { op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false } };
            if (req.client.ws && req.client.ws.shards) req.client.ws.shards.get(0).send(payload);
            else req.client.ws.broadcast(payload);
            res.json({ success: true });
        } catch (e) { console.error(e); res.json({ success: false }); }
    });

    app.post('/api/music/leave', async (req, res) => {
        const { guildId } = req.body;
        try {
            req.client.queueManager.delete(guildId);
            if (req.client.lavalink) await req.client.lavalink.destroyPlayer(guildId);

            const payload = { op: 4, d: { guild_id: guildId, channel_id: null } };
            if (req.client.ws && req.client.ws.shards) req.client.ws.shards.get(0).send(payload);
            else req.client.ws.broadcast(payload);

            res.json({ success: true });
        } catch (e) { console.error(e); res.json({ success: false }); }
    });

    app.post('/api/music/play', async (req, res) => {
        const { guildId, query } = req.body;
        if (!guildId || !query) return res.json({ success: false, message: 'Missing args' });

        try {
            const { playLogic } = require('../commands/play');
            const result = await playLogic(req.client, guildId, query);
            res.json(result);
        } catch (e) { console.error(e); res.json({ success: false, message: e.message }); }
    });

    const clonerState = {
        instance: null,
        isRunning: false,
        logs: [],
        sourceId: '',
        targetId: '',
        stats: {}
    };

    app.get('/server-cloner', (req, res) => {
        if (!req.client.user) return res.send('Bot loading...');
        res.render('server-cloner', {
            user: req.client.user,
            page: 'cloner'
        });
    });

    app.get('/api/cloner/status', (req, res) => {
        res.json({
            isRunning: clonerState.isRunning,
            logs: clonerState.logs,
            stats: clonerState.stats
        });
    });

    app.post('/api/cloner/fetch', async (req, res) => {
        const { guildId } = req.body;
        try {
            const guild = req.client.guilds.cache.get(guildId);
            if (!guild) return res.json({ success: false, message: 'Guild not found (Bot must be a member)' });

            const member = await guild.members.fetch(req.client.user.id).catch(() => null);
            const isAdmin = member ? member.permissions.has('ADMINISTRATOR') : false;

            res.json({
                success: true,
                name: guild.name,
                icon: guild.iconURL({ dynamic: true, size: 128 }),
                isAdmin: isAdmin,
                isOwner: guild.ownerId === req.client.user.id
            });
        } catch (e) { res.json({ success: false, message: e.message }); }
    });

    app.post('/api/cloner/start', async (req, res) => {
        if (clonerState.isRunning) return res.json({ success: false, message: 'Already running' });

        const { sourceId, targetId, options } = req.body;

        clonerState.isRunning = true;
        clonerState.logs = [];
        clonerState.stats = {};
        clonerState.sourceId = sourceId;
        clonerState.targetId = targetId;

        clonerState.logs.push(`[${new Date().toLocaleTimeString()}] Request received. Initializing...`);

        const ServerCloner = require('../cloner/ServerCloner');
        const cloner = new ServerCloner(req.client, (msg) => {
            clonerState.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
            if (clonerState.logs.length > 500) clonerState.logs.shift();
        });

        clonerState.instance = cloner;

        cloner.cloneServer(sourceId, targetId, options)
            .then(stats => {
                clonerState.stats = stats;
                clonerState.isRunning = false;
                clonerState.instance = null;
                clonerState.logs.push(`[${new Date().toLocaleTimeString()}] Process completed successfully.`);
            })
            .catch(err => {
                clonerState.isRunning = false;
                clonerState.instance = null;
                if (err.message !== 'Cloning stopped by user.') {
                    clonerState.logs.push(`[${new Date().toLocaleTimeString()}] Error: ${err.message}`);
                }
            });

        res.json({ success: true });
    });

    app.post('/api/cloner/stop', (req, res) => {
        if (clonerState.instance) {
            clonerState.instance.stop();
            res.json({ success: true, message: 'Stop signal sent.' });
        } else {
            res.json({ success: false, message: 'No active process' });
        }
    });

    app.listen(port, () => {
        console.log(`Dashboard is running on http://localhost:${port}`);
    });
};
require('dotenv').config();

process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning') return;
    console.warn(warning.name, warning.message);
});

require('./logger').initLogger();
const { Client } = require('discord.js-selfbot-v13');
const fs = require('fs');
const path = require('path');
const Lavalink = require('./music/lavalink');
const Queue = require('./music/queue');

global.clients = [];
global.totalTokens = 0;
global.loggedInTokens = 0;
const afkCooldowns = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [id, time] of afkCooldowns) {
        if (now - time > 3600000) afkCooldowns.delete(id);
    }
}, 3600000);

const dashboard = require('./dashboard/index');
const allowedManager = require('./commands/allowedManager');

function setupClient(tokenData, delayMs = 0) {
    const { key, token } = tokenData;
    const client = new Client({ checkUpdate: false });
    client.token = token;
    client.dataFolder = key === 'TOKEN' ? 'data' : key.toLowerCase() + 'data';
    client.tokenKey = key;

    client.ttsMap = new Map();
    const voiceStates = {};
    client.lavalinkVoiceStates = voiceStates;

    let lavalink = null;
    if (process.env.LAVALINK_WS && process.env.LAVALINK_REST && process.env.LAVALINK_PASSWORD) {
        lavalink = new Lavalink({
            restHost: process.env.LAVALINK_REST,
            wsHost: process.env.LAVALINK_WS,
            password: process.env.LAVALINK_PASSWORD,
            clientName: process.env.CLIENT_NAME || 'RanzeX',
        });
    } else {
        lavalink = new Lavalink({
            restHost: null,
            wsHost: null,
            password: null,
            clientName: process.env.CLIENT_NAME || 'RanzeX',
        });
    }

    client.commands = new Map();
    client.lavalink = lavalink;
    client.queueManager = new Queue();

    const commandsPath = path.join(__dirname, 'commands');
    if (fs.existsSync(commandsPath)) {
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            try {
                const command = require(path.join(commandsPath, file));
                if (command.name) {
                    client.commands.set(command.name, command);
                }
            } catch (error) {
                console.error(`[${key}] Error loading command ${file}:`, error);
            }
        }
    }

    client.on('ready', () => {
        global.loggedInTokens++;
        const remain = global.totalTokens - global.loggedInTokens;

        console.log(`[${key}] Authenticated (${global.loggedInTokens}/${global.totalTokens}) - User: ${client.user.tag} (${client.user.id}) - Remaining: ${remain}`);

        console.log(`[${key}] RanzeX is ready!`);
        console.log(`[${key}] Loaded ${client.commands.size} commands`);

        if (client.lavalink) {
            client.lavalink.connect(client.user.id);
            console.log(`[${key}] Connecting to Lavalink...`);
        }

        const rpcManager = require('./commands/rpcManager');
        rpcManager.initialize(client);

        const reactionManager = require('./commands/reactionManager');
        reactionManager.initialize(client);

        const aiManager = require('./commands/aiManager');
        aiManager.initialize(client);

        const statusManager = require('./commands/statusManager');

        setInterval(async () => {
            const data = rpcManager.loadData(client);
            await rpcManager.setPresence(client, data);
        }, 10 * 60 * 1000);

        const mirrorManager = require('./commands/mirrorManager');
        mirrorManager.initialize(client);

        const autoMsg = require('./commands/autoMsg');
        autoMsg.initialize(client);

        const timedMsg = require('./commands/timedMsg');
        timedMsg.initialize(client);

        try {
            const waifuManager = require('./commands/waifuManager');
            waifuManager.initialize(client);
        } catch (e) { }
    });

    if (client.lavalink) {
        client.ws.on('VOICE_STATE_UPDATE', (packet) => {
            if (packet.user_id !== client.user.id) return;
            const guildId = packet.guild_id;
            if (!voiceStates[guildId]) voiceStates[guildId] = {};
            voiceStates[guildId].sessionId = packet.session_id;
            if (packet.channel_id) {
                voiceStates[guildId].channelId = packet.channel_id;
            }
        });

        client.ws.on('VOICE_SERVER_UPDATE', (packet) => {
            const guildId = packet.guild_id;
            if (!voiceStates[guildId]) voiceStates[guildId] = {};
            voiceStates[guildId].token = packet.token;
            voiceStates[guildId].endpoint = packet.endpoint;
        });

        client.lavalink.on('ready', () => {
            console.log(`[Lavalink] Session established for ${client.user.tag}`);
        });

        client.lavalink.on('event', async (evt) => {
            if (evt.type === 'TrackEndEvent') {
                if (evt.reason === 'finished' || evt.reason === 'loadFailed') {
                    const queue = client.queueManager.get(evt.guildId);
                    if (!queue) return;

                    if (queue.nowPlaying) {
                        if (queue.loop === 'track') {
                            queue.songs.unshift(queue.nowPlaying);
                        } else if (queue.loop === 'queue') {
                            queue.history.push(queue.nowPlaying);
                            queue.songs.push(queue.nowPlaying);
                        } else {
                            queue.history.push(queue.nowPlaying);
                        }
                    }

                    let nextSong = client.queueManager.getNext(evt.guildId);

                    if (queue.autoplay && queue.songs.length < 5) {
                        await client.queueManager.fillAutoplayQueue(client, evt.guildId);
                        if (!nextSong) {
                            nextSong = client.queueManager.getNext(evt.guildId);
                        }
                    }

                    if (!nextSong) {
                        await client.lavalink.destroyPlayer(evt.guildId);
                        client.queueManager.delete(evt.guildId);
                        if (queue.textChannel) {
                            queue.textChannel.send('```Queue finished' + (queue.autoplay ? ' (Autoplay failed to find songs)' : '') + '```').catch(() => { });
                        }
                        return;
                    }

                    queue.nowPlaying = nextSong;
                    const voiceState = voiceStates[evt.guildId];

                    if (voiceState && voiceState.token && voiceState.sessionId && voiceState.endpoint) {
                        try {
                            await client.lavalink.updatePlayer(evt.guildId, nextSong, voiceState, {
                                volume: queue.volume,
                                filters: queue.filters
                            });

                            if (queue.textChannel) {
                                let nowPlayingMsg = '```\n';
                                nowPlayingMsg += '╭─[ NOW PLAYING ]─╮\n\n';
                                nowPlayingMsg += `  🎵 ${nextSong.info.title}\n`;
                                nowPlayingMsg += `  👤 ${nextSong.info.author}\n`;
                                nowPlayingMsg += '\n╰──────────────────────────────────╯\n```';
                                queue.textChannel.send(nowPlayingMsg).catch(() => { });
                            }
                        } catch (err) {
                            console.error(`[Auto-play Error - ${key}]:`, err);
                            if (queue.textChannel) {
                                queue.textChannel.send('```Error playing next song```').catch(() => { });
                            }
                        }
                    }
                }
            }
        });

        client.lavalink.on('playerUpdate', (packet) => {
            const queue = client.queueManager.get(packet.guildId);
            if (queue && packet.state) {
                queue.position = packet.state.position;
                queue.lastUpdate = Date.now();
            }
        });
    }

    client.on('guildMemberAdd', async member => {
        try {
            const welcomerManager = require('./commands/welcomerManager');
            const setup = welcomerManager.getSetup(client, member.guild.id);

            if (setup && setup.channelId) {
                const channel = member.guild.channels.cache.get(setup.channelId);
                if (channel) {
                    if (setup.welcomeType === 'text') {
                        let txt = setup.textMessage || 'hey {user} welcome to the {server} you are {count} member';
                        txt = txt.replace(/{user}/g, `<@${member.user.id}>`);
                        txt = txt.replace(/{server}/g, member.guild.name || 'Server');
                        txt = txt.replace(/{count}/g, member.guild.memberCount || 1);
                        await channel.send(txt).catch(() => { });
                    } else {
                        const { createCanvas, loadImage } = require('canvas');
                        const dataDir = path.join(__dirname, client.dataFolder);
                        const extList = ['.png', '.jpg', '.jpeg', '.webp'];
                        let bgPath = path.join(__dirname, 'dashboard', 'public', 'welcome.jpg');

                        for (const ext of extList) {
                            const checkPath = path.join(dataDir, `welcome${ext}`);
                            if (fs.existsSync(checkPath)) {
                                bgPath = checkPath;
                                break;
                            }
                        }

                        const canvas = createCanvas(1024, 450);
                        const ctx = canvas.getContext('2d');
                        const background = await loadImage(bgPath);
                        ctx.drawImage(background, 0, 0, canvas.width, canvas.height);

                        ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
                        ctx.fillRect(0, 0, canvas.width, canvas.height);

                        const cleanGuild = member.guild.name.replace(/[^\x00-\x7F]/g, "").trim() || "Server";
                        let cleanUser = member.user.username.replace(/[^\x00-\x7F]/g, "").trim() || "User";
                        if (member.user.discriminator && member.user.discriminator !== '0') {
                            cleanUser += `#${member.user.discriminator}`;
                        }

                        let userColor = setup.textcolor || '#ffffff';
                        if (/^[0-9A-Fa-f]{6}$/.test(userColor)) userColor = '#' + userColor;

                        ctx.textAlign = 'center';
                        const lines = (setup.cardMessage || "WELCOME TO {server}\n{user}\nMember #{count}").split('\n');
                        let startY = 290;

                        lines.forEach((line) => {
                            let parsedLine = line.replace(/{server}/gi, cleanGuild)
                                .replace(/{user}/gi, cleanUser)
                                .replace(/{count}/gi, member.guild.memberCount.toString());

                            if (line.toLowerCase().includes('{user}')) {
                                ctx.font = 'bold 50px Arial';
                                ctx.fillStyle = userColor;
                                startY += 10;
                            } else {
                                ctx.font = 'bold 36px Arial';
                                ctx.fillStyle = '#ffffff';
                            }
                            ctx.fillText(parsedLine, canvas.width / 2, startY);
                            startY += 45;
                        });

                        const userAvatar = member.user.displayAvatarURL({ format: 'png', size: 256 }) || 'https://cdn.discordapp.com/embed/avatars/0.png';
                        const avatar = await loadImage(userAvatar);

                        const arcX = canvas.width / 2;
                        const arcY = 140;
                        const arcRadius = 90;

                        ctx.save();
                        ctx.beginPath();
                        ctx.arc(arcX, arcY, arcRadius, 0, Math.PI * 2, true);
                        ctx.closePath();
                        ctx.clip();
                        ctx.drawImage(avatar, arcX - arcRadius, arcY - arcRadius, arcRadius * 2, arcRadius * 2);
                        ctx.restore();

                        ctx.beginPath();
                        ctx.arc(arcX, arcY, arcRadius, 0, Math.PI * 2, true);
                        ctx.closePath();
                        ctx.lineWidth = 8;
                        ctx.strokeStyle = userColor;
                        ctx.stroke();

                        const buffer = canvas.toBuffer('image/png');

                        await channel.send({
                            files: [{
                                attachment: buffer,
                                name: 'welcome.png'
                            }]
                        }).catch(() => { });
                    }
                }
            }
        } catch (e) {
            console.error(`[Welcomer Canvas Event Error - ${key}]:`, e);
        }
    });

    client.on('messageCreate', async (message) => {
        try {
            if (!message.author) return;

            const mimicManager = require('./commands/mimicManager');
            mimicManager.handle(message, client);

            const mentionsMe = message.mentions.users.has(client.user.id);
            const isDm = message.channel.type === 'DM';

            if ((mentionsMe || isDm) && message.author.id !== client.user.id) {
                const afkPath = path.join(__dirname, client.dataFolder, 'afk.json');
                const logPath = path.join(__dirname, client.dataFolder, 'afklog.json');

                let afkData = { isOn: false, reason: '', logsEnabled: false };
                if (fs.existsSync(afkPath)) {
                    afkData = JSON.parse(fs.readFileSync(afkPath, 'utf8'));
                }

                if (afkData.logsEnabled) {
                    let logs = [];
                    if (fs.existsSync(logPath)) {
                        logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
                    }

                    let cleanContent = message.content;
                    cleanContent = cleanContent.replace(/<@!?(\d+)>/g, (match, id) => {
                        const user = client.users.cache.get(id);
                        return user ? `@${user.username}` : match;
                    });
                    cleanContent = cleanContent.replace(/<@&(\d+)>/g, (match, id) => {
                        const role = message.guild ? message.guild.roles.cache.get(id) : null;
                        return role ? `@${role.name}` : match;
                    });
                    cleanContent = cleanContent.replace(/<#(\d+)>/g, (match, id) => {
                        const channel = client.channels.cache.get(id);
                        return channel ? `#${channel.name}` : match;
                    });
                    cleanContent = cleanContent.replace(/<a?:(\w+):(\d+)>/g, ':$1:');

                    const logEntry = {
                        id: Date.now().toString(),
                        user: message.author.tag,
                        userId: message.author.id,
                        channel: isDm ? 'DM' : message.channel.name || 'Unknown',
                        guild: message.guild ? message.guild.name : 'Direct Message',
                        content: cleanContent,
                        time: new Date().toLocaleString(),
                        link: message.url
                    };

                    logs.unshift(logEntry);
                    if (logs.length > 50) logs = logs.slice(0, 50);
                    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
                }

                if (afkData.isOn) {
                    const now = Date.now();
                    const lastReply = afkCooldowns.get(message.author.id) || 0;
                    const startTime = afkData.startTime || 0;
                    const cooldown = 5 * 60 * 1000;

                    if (now - lastReply >= cooldown || lastReply < startTime) {
                        const reason = afkData.reason || "I'm currently AFK.";
                        try {
                            await message.reply(`${reason}`);
                            afkCooldowns.set(message.author.id, now);
                        } catch (err) {
                            console.error(`[AFK Error - ${key}]: Failed to reply to AFK ping`, err.message);
                        }
                    }
                }
            }

            if (allowedManager.isAllowed(client, message.author.id)) {
                try {
                    const igManager = require('./commands/igManager');
                    const igHandled = await igManager.handle(message);
                    if (igHandled) return;
                } catch (e) { }

                try {
                    const ytManager = require('./commands/ytManager');
                    const ytHandled = await ytManager.handle(message);
                    if (ytHandled) return;
                } catch (e) { }

                const calculator = require('./commands/calculator');
                const handled = await calculator.handle(message);
                if (handled) return;

                const currency = require('./commands/currency');
                const currencyHandled = await currency.handle(message);
                if (currencyHandled) return;

                const qrManager = require('./commands/qrManager');
                const qrHandled = await qrManager.handle(message, client, true);
                if (qrHandled) return;

                const ipCommand = require('./commands/ip');
                const ipHandled = await ipCommand.handle(message);
                if (ipHandled) return;

                if (message.guild && client.ttsMap && client.ttsMap.has(message.guild.id)) {
                    const bindChannelId = client.ttsMap.get(message.guild.id);
                    const prefix = process.env.PREFIX || '!';
                    if (message.channel.id === bindChannelId && !message.content.startsWith(prefix)) {
                        const ttsCommand = client.commands.get('tts');
                        if (ttsCommand && ttsCommand.speak) {
                            try {
                                await ttsCommand.speak(message, client);
                            } catch (err) {
                                console.error(`[TTS Error - ${key}]:`, err.message);
                            }
                        }
                    }
                }
            }

            const prefix = process.env.PREFIX || '!';
            if (!message.content.startsWith(prefix)) return;

            const args = message.content.slice(prefix.length).trim().split(/ +/);
            const commandName = args.shift().toLowerCase();

            if (!allowedManager.isAllowed(client, message.author.id)) {
                return;
            }

            const command = client.commands.get(commandName);

            if (!command) {
                const clipboardManager = require('./commands/clipboardManager');
                const responseText = clipboardManager.getResponse(client, commandName);

                if (responseText) {
                    const referenceId = message.reference ? message.reference.messageId : null;

                    if (message.author.id === client.user.id) {
                        try { await message.delete(); } catch (e) { }
                    } else if (message.guild && message.guild.me.permissionsIn(message.channel).has('MANAGE_MESSAGES')) {
                        try { await message.delete(); } catch (e) { }
                    }

                    if (referenceId) {
                        try {
                            const repliedMsg = await message.channel.messages.fetch(referenceId);
                            if (repliedMsg) {
                                await repliedMsg.reply({ content: responseText, allowedMentions: { repliedUser: true } });
                            } else {
                                await message.channel.send(responseText).catch(() => { });
                            }
                        } catch (e) {
                            await message.channel.send(responseText).catch(() => { });
                        }
                    } else {
                        await message.channel.send(responseText).catch(() => { });
                    }
                    return;
                }
            }

            if (!command) return;

            try {
                await command.execute(message, args, client);
            } catch (err) {
                console.error(`[Command Error - ${key}] ${commandName}:`, err.message);
            }
        } catch (error) {
            console.error(`[Message Event Error - ${key}]`, error.message);
        }
    });

    global.clients.push(client);

    setTimeout(() => {
        client.login(token).catch(error => {
            console.error(`[${key}] Failed to login:`, error.message);
        });
    }, delayMs);
}

global.setupClient = setupClient;

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Anti-Crash] Unhandled Promise Rejection:\n', reason);
});

process.on('uncaughtException', (error, origin) => {
    console.error('[Anti-Crash] Uncaught Exception/Catch:\n', error, '\nOrigin:', origin);
});

process.on('uncaughtExceptionMonitor', (error, origin) => {
    console.error('[Anti-Crash] Uncaught Exception Monitor:\n', error, '\nOrigin:', origin);
});

const tokens = [];
for (const [key, value] of Object.entries(process.env)) {
    if ((key === 'TOKEN' || /^TOKEN\d+$/.test(key)) && value && value.trim() !== '') {
        tokens.push({ key, token: value.trim() });
    }
}

if (tokens.length === 0) {
    console.error('Error: No TOKEN found in .env file');
    process.exit(1);
}

global.totalTokens = tokens.length;
console.log(`[Boot] Multi-Token Initialization Sequence Started`);
console.log(`[Boot] Found ${global.totalTokens} accounts in .env`);

let currentDelay = 0;
for (const t of tokens) {
    setupClient(t, currentDelay);
    currentDelay += 10000;
}

dashboard(global.clients);
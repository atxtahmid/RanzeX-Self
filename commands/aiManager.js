const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

function getPaths(client) {
    const folder = client && client.dataFolder ? client.dataFolder : 'data';
    return {
        CONFIG_PATH: path.join(__dirname, '..', folder, 'ai_config.json'),
        HISTORY_PATH: path.join(__dirname, '..', folder, 'chat_history.json')
    };
}

const DEFAULT_CONFIG = {
    global: false,
    enabledServers: [],
    enabledChannels: [],
    dmUsers: [],
    enabledGroups: [],
    enabledGroupsMention: [],
    freeWillChannels: [],
    aiName: "Yushi",
    backstory: "You are Yushi, a helpful and witty AI assistant.",
    personality: "Friendly, helpful, and sometimes sarcastic.",
    rules: "Keep responses concise. Do not ping @everyone.",
    modelType: "slow",
    bannedWords: ["age", "year old", "y/o", "birth"],
    disablePing: false,
    blockedUsers: []
};

function loadData(client) {
    try {
        const { CONFIG_PATH } = getPaths(client);
        if (!fs.existsSync(CONFIG_PATH)) {
            const dir = path.dirname(CONFIG_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 4));
            return DEFAULT_CONFIG;
        }
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        if (!raw.trim()) throw new Error('Empty file');

        let data = JSON.parse(raw);
        data = { ...DEFAULT_CONFIG, ...data };

        return data;
    } catch (e) {
        console.error('[AI Manager] Failed to load config, using defaults:', e.message);
        return DEFAULT_CONFIG;
    }
}

function saveData(client, data) {
    try {
        const { CONFIG_PATH } = getPaths(client);
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const existing = loadData(client);
        const finalData = { ...existing, ...data };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(finalData, null, 4));
    } catch (e) {
        console.error('[AI Manager] Failed to save config:', e);
    }
}

function loadHistory(client) {
    const { HISTORY_PATH } = getPaths(client);
    if (!fs.existsSync(HISTORY_PATH)) {
        fs.writeFileSync(HISTORY_PATH, JSON.stringify({}, null, 4));
        return {};
    }
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
}

function saveHistory(client, history) {
    const { HISTORY_PATH } = getPaths(client);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 4));
}

function getContext(client, userId, config) {
    const history = loadHistory(client);
    const userHistory = history[userId] || [];

    const systemMsg = {
        role: "system",
        content: `Name: ${config.aiName}\nBackstory: ${config.backstory}\nPersonality: ${config.personality}\nRules: ${config.rules}`
    };

    const messages = [systemMsg, ...userHistory];
    return messages;
}

async function addHistory(client, userId, userContent, aiContent) {
    let history = loadHistory(client);
    if (!history[userId]) history[userId] = [];

    history[userId].push({ role: "user", content: userContent });
    history[userId].push({ role: "assistant", content: aiContent });

    if (history[userId].length > 10) {
        history[userId] = history[userId].slice(history[userId].length - 10);
    }

    saveHistory(client, history);
}

const requestQueue = [];
let processing = false;

async function queueAIRequest(fn) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ fn, resolve, reject });
        processQueue();
    });
}

async function processQueue() {
    if (processing || requestQueue.length === 0) return;
    processing = true;

    while (requestQueue.length > 0) {
        const { fn, resolve, reject } = requestQueue.shift();
        try {
            resolve(await fn());
        } catch (e) {
            reject(e);
        }
        await new Promise(r => setTimeout(r, 4500));
    }

    processing = false;
}

async function generateReply(client, userId, userContent) {
    const config = loadData(client);
    const messages = getContext(client, userId, config);

    messages.push({ role: "user", content: userContent });

    try {
        const response = await queueAIRequest(() =>
            fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.AI_API}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: "gemini-3.5-flash",
                    messages: messages,
                    temperature: 1.0,
                    top_p: 1.0,
                    max_tokens: 8192,
                    reasoning_effort: "medium"
                })
            })
        );

        if (!response.ok) {
            console.error(`[AI] HTTP Error: ${response.status} ${await response.text()}`);
            return "what you mean?";
        }

        const data = await response.json();
        let fullContent = data.choices?.[0]?.message?.content || "";

        fullContent = fullContent.replace(/<think>[\s\S]*?(?:<\/think>|$)\s*/gi, '');

        if (fullContent.trim()) {
            await addHistory(client, userId, userContent, fullContent);
            return fullContent;
        }

        return "what you mean?";

    } catch (error) {
        console.error("[AI] Error generating reply:", error);
        return "what you mean?";
    }
}

function initialize(client) {
    console.log("[AI System] Initializing...");

    client.on('messageCreate', async (message) => {
        try {
            if (message.author.bot) return;
            if (!client.user || message.author.id === client.user.id) return;
            if (message.system || !message.content || !message.content.trim()) return;

            const ignoredTypes = ['RECIPIENT_ADD', 'RECIPIENT_REMOVE', 'CALL', 'CHANNEL_NAME_CHANGE', 'CHANNEL_ICON_CHANGE', 'PINS_ADD'];
            if (ignoredTypes.includes(message.type)) return;

            const config = loadData(client);
            const content = message.content;
            const guildId = message.guild?.id;
            const channelId = message.channel.id;
            const authorId = message.author.id;

            if (config.bannedWords && config.bannedWords.some(w => content.toLowerCase().includes(w.toLowerCase()))) {
                return;
            }

            if (config.blockedUsers && config.blockedUsers.includes(authorId)) {
                return;
            }

            let shouldReply = false;
            let freeWillDelay = 0;
            let isFreeWill = false;

            if (!guildId) {
                if (config.dmUsers && config.dmUsers.includes(authorId)) {
                    shouldReply = true;
                }
                if (config.enabledGroups && config.enabledGroups.includes(channelId)) {
                    shouldReply = true;
                }
                if (config.enabledGroupsMention && config.enabledGroupsMention.includes(channelId)) {
                    if (message.mentions.users.has(client.user.id)) {
                        shouldReply = true;
                    }
                }
            } else {
                if (config.freeWillChannels) {
                    const fwItem = config.freeWillChannels.find(x => typeof x === 'object' ? x.id === channelId : x === channelId);
                    if (fwItem) {
                        shouldReply = true;
                        isFreeWill = true;
                        freeWillDelay = typeof fwItem === 'object' ? (fwItem.delay || 0) : 0;
                    }
                }

                if (!isFreeWill) {
                    const isMentioned = message.mentions.users.has(client.user.id);
                    if (isMentioned) {
                        if (config.global) {
                            shouldReply = true;
                        } else {
                            const serverAllowed = config.enabledServers && config.enabledServers.includes(guildId);
                            const channelAllowed = config.enabledChannels && config.enabledChannels.includes(channelId);
                            if (serverAllowed || channelAllowed) {
                                shouldReply = true;
                            }
                        }
                    }
                }
            }

            if (content.includes('@everyone') || content.includes('@here')) {
            }

            if (shouldReply) {
                const processReply = async () => {
                    const startTime = Date.now();
                    message.channel.sendTyping().catch(() => { });
                    const effectiveContent = `(User: ${message.author.username}) ${content}`;
                    const reply = await generateReply(client, authorId, effectiveContent);

                    if (freeWillDelay > 0) {
                        const timeTaken = Date.now() - startTime;
                        const targetDelayMs = freeWillDelay * 1000;
                        if (targetDelayMs > timeTaken) {
                            await new Promise(resolve => setTimeout(resolve, targetDelayMs - timeTaken));
                        }
                    }

                    if (reply && reply.trim().length > 0) {
                        try {
                            await message.reply({
                                content: reply,
                                allowedMentions: { repliedUser: !config.disablePing }
                            });
                        } catch (e) {
                            await message.channel.send(reply).catch(err => console.error("[AI] Failed to send:", err));
                        }
                    }
                };

                if (isFreeWill && freeWillDelay > 0) {
                    if (!client.freeWillQueues) client.freeWillQueues = new Map();
                    const currentQueue = client.freeWillQueues.get(channelId) || Promise.resolve();

                    const nextQueue = currentQueue
                        .then(() => processReply())
                        .catch(err => console.error("[AI Queue Error]:", err));

                    client.freeWillQueues.set(channelId, nextQueue);
                } else {
                    processReply().catch(err => console.error("[AI Process Error]:", err));
                }
            }
        } catch (error) {
            console.error("Error in AI messageCreate:", error);
        }
    });
}

module.exports = {
    loadData,
    saveData,
    initialize
};
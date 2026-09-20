const { Client } = require('@discordjs/core');
const { REST, DefaultRestOptions } = require('@discordjs/rest');
const { WebSocketManager, WebSocketShard } = require('@discordjs/ws');
const { USER_AGENT, Properties } = require('./constants');
const https = require('https');
const http = require('http');

const MIN_REQUEST_GAP = 300;
const BUILD_TTL = 1800000;
const FALLBACK_BUILD = 504649;

let lastRequestTime = 0;
let cachedBuild = 0;
let cachedBuildTs = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function throttleRequest() {
    const now = Date.now();
    const gap = now - lastRequestTime;
    if (gap < MIN_REQUEST_GAP) {
        await sleep(MIN_REQUEST_GAP - gap + Math.random() * 100);
    }
    lastRequestTime = Date.now();
}

async function makeRequest(url, init) {
    await throttleRequest();

    if (init.headers) {
        const myHeaders = new Headers(init.headers);
        if (myHeaders.has('User-Agent')) {
            myHeaders.set('User-Agent', USER_AGENT);
        }
        if (myHeaders.has('Authorization')) {
            const token = myHeaders.get('Authorization').replace('Bot ', '');
            myHeaders.set('Authorization', token);
        }

        myHeaders.append('accept-language', 'en-US');
        myHeaders.append('origin', 'https://discord.com');
        myHeaders.append('pragma', 'no-cache');
        myHeaders.append('priority', 'u=1, i');
        myHeaders.append('referer', 'https://discord.com/channels/@me');
        myHeaders.append('sec-ch-ua', '"Not)A;Brand";v="8", "Chromium";v="138"');
        myHeaders.append('sec-ch-ua-mobile', '?0');
        myHeaders.append('sec-ch-ua-platform', '"Windows"');
        myHeaders.append('sec-fetch-dest', 'empty');
        myHeaders.append('sec-fetch-mode', 'cors');
        myHeaders.append('sec-fetch-site', 'same-origin');
        myHeaders.append('x-debug-options', 'bugReporterEnabled');
        myHeaders.append('x-discord-locale', 'en-US');
        myHeaders.append('x-discord-timezone', 'Asia/Kolkata');
        myHeaders.append('x-super-properties', Buffer.from(JSON.stringify(Properties)).toString('base64'));

        init.headers = myHeaders;
    }
    return DefaultRestOptions.makeRequest(url, init);
}

const originalSend = WebSocketShard.prototype.send;
WebSocketShard.prototype.send = async function (payload) {
    if (payload.op === 2) {
        payload.d = {
            token: payload.d.token,
            properties: {
                ...Properties,
                is_fast_connect: false,
                gateway_connect_reasons: 'AppSkeleton',
            },
            capabilities: 0,
            presence: payload.d.presence,
            compress: payload.d.compress,
            client_state: { guild_versions: {} },
        };
    }
    return originalSend.call(this, payload);
};

async function fetchBuildNumber() {
    if (cachedBuild && (Date.now() - cachedBuildTs) < BUILD_TTL) {
        return cachedBuild;
    }

    return new Promise((resolve) => {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36';

        const get = (url) => new Promise((res) => {
            const proto = url.startsWith('https') ? https : http;
            proto.get(url, { headers: { 'User-Agent': ua } }, (r) => {
                let data = '';
                r.on('data', c => data += c);
                r.on('end', () => res(data));
            }).on('error', () => res(''));
        });

        get('https://discord.com/app').then((html) => {
            const re = /\/assets\/([a-f0-9]+)\.js/g;
            const hashes = [];
            let m;
            while ((m = re.exec(html)) !== null) hashes.push(m[1]);

            if (hashes.length === 0) {
                resolve(cachedBuild || FALLBACK_BUILD);
                return;
            }

            const tryNext = async (idx) => {
                if (idx >= Math.min(hashes.length, 5)) {
                    resolve(cachedBuild || FALLBACK_BUILD);
                    return;
                }
                const assetHash = hashes[hashes.length - 1 - idx];
                const js = await get(`https://discord.com/assets/${assetHash}.js`);
                const match = js.match(/buildNumber["\s:]+["\s]*(\d{5,7})/);
                if (match) {
                    cachedBuild = parseInt(match[1]);
                    cachedBuildTs = Date.now();
                    resolve(cachedBuild);
                } else {
                    tryNext(idx + 1);
                }
            };

            tryNext(0);
        }).catch(() => resolve(cachedBuild || FALLBACK_BUILD));
    });
}

class WorkerAPI {
    constructor(token, buildNumber, proxy = null) {
        this.token = token;
        this.buildNumber = buildNumber;
        this.proxy = proxy;
        this.agent = null;

        if (proxy) {
            const proxyUrl = proxy.startsWith('http') ? proxy : `http://${proxy}`;
            try {
                const url = new URL(proxyUrl);
                this.agent = {
                    http: new (require('http').Agent)({ keepAlive: false }),
                    https: new (require('https').Agent)({ keepAlive: false }),
                };
            } catch (e) {
                this.agent = null;
            }
        }
    }

    getHeaders() {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';
        const superProps = Buffer.from(JSON.stringify({
            os: 'Windows',
            browser: 'Discord Client',
            release_channel: 'stable',
            client_version: '1.0.9175',
            os_version: '10.0.26100',
            os_arch: 'x64',
            app_arch: 'x64',
            system_locale: 'en-US',
            browser_user_agent: ua,
            browser_version: '32.2.7',
            client_build_number: this.buildNumber,
            native_build_number: 59498,
            client_event_source: null,
        })).toString('base64');

        return {
            'Authorization': this.token,
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': ua,
            'X-Super-Properties': superProps,
            'X-Discord-Locale': 'en-US',
            'X-Discord-Timezone': 'Asia/Ho_Chi_Minh',
            'Origin': 'https://discord.com',
            'Referer': 'https://discord.com/channels/@me',
        };
    }

    async request(method, path, body = null, extraHeaders = {}) {
        await throttleRequest();

        const url = `https://discord.com/api/v9${path}`;
        const headers = { ...this.getHeaders(), ...extraHeaders };
        const bodyStr = body ? JSON.stringify(body) : null;
        if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

        return new Promise((resolve, reject) => {
            const proto = url.startsWith('https') ? https : http;
            const urlObj = new URL(url);

            const req = proto.request({
                hostname: urlObj.hostname,
                port: urlObj.port || 443,
                path: urlObj.pathname + urlObj.search,
                method,
                headers,
                agent: this.agent ? this.agent.https : undefined,
            }, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = data ? JSON.parse(data) : null; } catch (e) {}
                    resolve({ status: res.statusCode, body: parsed, text: data });
                });
            });

            req.on('error', reject);
            if (bodyStr) req.write(bodyStr);
            req.end();
        });
    }

    get(path, extraHeaders = {}) {
        return this.request('GET', path, null, extraHeaders);
    }

    post(path, body = null, extraHeaders = {}) {
        return this.request('POST', path, body, extraHeaders);
    }
}

class ClientQuest extends Client {
    constructor(token) {
        const rest = new REST({ version: '10', makeRequest }).setToken(token);
        const gateway = new WebSocketManager({
            token: token,
            intents: 0,
            rest,
        });

        gateway.fetchGatewayInformation = () => {
            return Promise.resolve({
                url: 'wss://gateway.discord.gg',
                shards: 1,
                session_start_limit: {
                    total: 1000,
                    remaining: 1000,
                    reset_after: 14400000,
                    max_concurrency: 1,
                },
            });
        };

        super({ rest, gateway });
        this.websocketManager = gateway;
        this.questManager = null;
    }

    connect() {
        return this.websocketManager.connect();
    }

    async fetchQuests(workerAPI) {
        const { QuestManager } = require('./questManager');
        const response = await this.rest.get('/quests/@me');
        this.questManager = QuestManager.fromResponse(this, response, workerAPI);
        return this.questManager;
    }
}

module.exports = { ClientQuest, WorkerAPI, fetchBuildNumber, throttleRequest };
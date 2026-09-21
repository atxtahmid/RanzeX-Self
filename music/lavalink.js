const WebSocket = require('ws');
const https = require('https');
const http = require('http');

const DEFAULT_NODES = [
    { name: 'AjieDev v4', host: 'lava-v4.ajieblogs.eu.org', port: 443, password: 'https://dsc.gg/ajidevserver', secure: true },
    { name: 'Jirayu v4', host: 'lavalink.jirayu.net', port: 13592, password: 'youshallnotpass', secure: false },
    { name: 'HeavenCloud', host: 'free-lava.heavencloud.in', port: 4000, password: 'heavencloud.in', secure: false },
    { name: 'Muzykant v4', host: 'lavalink_v4.muzykant.xyz', port: 443, password: 'https://discord.gg/v6sdrD9kPh', secure: true },
    { name: 'TechByte v4', host: 'lavahatry4.techbyte.host', port: 3000, password: 'NAIGLAVA-dash.techbyte.host', secure: false },
    { name: 'Oreshi Proxy', host: 'proxy.oreshi.com', port: 2333, password: 'https://discord.gg/RPCfvBSUuM', secure: false },
    { name: 'Disutils 1', host: 'lavalink-1.is-it.pink', port: 443, password: 'https://disutils.com', secure: true },
    { name: 'Disutils 2', host: 'lavalink-2.is-it.pink', port: 443, password: 'https://disutils.com', secure: true },
    { name: 'LexNet EU', host: 'eu-lavalink.lexnet.cc', port: 443, password: 'lexn3tl@val!nk', secure: true }
];

class Lavalink {
    constructor({ restHost, wsHost, password, clientName }) {
        this.clientName = clientName;
        this.sessionId = null;
        this.ws = null;
        this.userId = null;
        this.listeners = new Map();

        this.nodes = [];
        if (restHost && wsHost && password) {
            const secure = wsHost.startsWith('wss');
            this.nodes.push({
                name: 'Primary (from .env)',
                host: (() => { try { return new URL(wsHost).hostname; } catch (e) { return null; } })(),
                port: (() => { try { const u = new URL(wsHost); return u.port ? parseInt(u.port) : (u.protocol === 'wss:' ? 443 : 80); } catch (e) { return null; } })(),
                password,
                secure,
                restOverride: restHost
            });
        }

        for (const n of DEFAULT_NODES) {
            this.nodes.push({ ...n });
        }

        this.currentIndex = -1;
        this.isConnecting = false;
        this.reconnectTimer = null;
        this.primaryRetryTimer = null;
        this.connectionDeadline = null;
    }

    get current() {
        return this.currentIndex >= 0 ? this.nodes[this.currentIndex] : null;
    }

    buildRestUrl(node) {
        if (node.restOverride) return node.restOverride;
        return `${node.secure ? 'https' : 'http'}://${node.host}:${node.port}/v4`;
    }

    buildWsUrl(node) {
        return `${node.secure ? 'wss' : 'ws'}://${node.host}:${node.port}/v4/websocket`;
    }

    async connect(userId) {
        this.userId = userId;

        if (this.currentIndex === -1) {
            this.currentIndex = 0;
        }

        this.clearPrimaryRetry();
        await this.tryConnect();
    }

    async tryConnect() {
        if (this.isConnecting) return;
        if (this.currentIndex >= this.nodes.length) {
            console.error('[Lavalink] All nodes failed. Retrying from top in 30s...');
            this.currentIndex = 0;
            this.scheduleReconnect(30000);
            return;
        }

        const node = this.nodes[this.currentIndex];
        this.isConnecting = true;

        console.log(`[Lavalink] Trying node #${this.currentIndex + 1}: ${node.name} (${node.host}:${node.port})`);

        try {
            await this.attemptWebSocket(node);
        } catch (e) {
            console.error(`[Lavalink] Node "${node.name}" failed: ${e.message}`);
            this.isConnecting = false;
            this.moveToNextNode();
        }
    }

    attemptWebSocket(node) {
        return new Promise((resolve, reject) => {
            if (this.ws) {
                try { this.ws.removeAllListeners(); this.ws.close(); } catch (e) { }
                this.ws = null;
            }

            const wsUrl = this.buildWsUrl(node);
            let settled = false;

            const ws = new WebSocket(wsUrl, {
                headers: {
                    Authorization: node.password,
                    'User-Id': this.userId,
                    'Client-Name': this.clientName,
                },
                handshakeTimeout: 8000
            });

            this.ws = ws;

            this.connectionDeadline = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { ws.close(); } catch (e) { }
                reject(new Error('Connection timeout (8s)'));
            }, 8000);

            ws.on('open', () => {
                if (settled) return;
                this.clearDeadline();
                console.log(`[Lavalink] WebSocket open: ${node.name}`);
                this.onConnected(node);
                resolve();
            });

            ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg);
                    this.handlePayload(data, node);
                } catch (err) {
                    console.error('[Lavalink] Parse error:', err.message);
                }
            });

            ws.on('error', (error) => {
                if (settled) return;
                settled = true;
                this.clearDeadline();
                reject(error);
            });

            ws.on('close', (code, reason) => {
                this.clearDeadline();
                const reasonStr = reason ? reason.toString() : 'no reason';
                console.log(`[Lavalink] Closed (${code}) ${reasonStr} — was on ${node.name}`);
                this.sessionId = null;

                if (settled) {
                    this.moveToNextNode();
                }
            });
        });
    }

    onConnected(node) {
        this.isConnecting = false;
        this.emit('nodeChange', node);
    }

    handlePayload(payload, node) {
        switch (payload.op) {
            case 'ready':
                this.sessionId = payload.sessionId;
                console.log(`[Lavalink] Session: ${this.sessionId} (node: ${node.name})`);
                this.emit('ready', payload);
                this.schedulePrimaryRetry();
                break;
            case 'playerUpdate':
                this.emit('playerUpdate', payload);
                break;
            case 'event':
                this.emit('event', payload);
                break;
            case 'stats':
                this.emit('stats', payload);
                break;
        }
    }

    moveToNextNode() {
        if (this.ws) {
            try { this.ws.removeAllListeners(); this.ws.close(); } catch (e) { }
            this.ws = null;
        }
        this.sessionId = null;
        this.isConnecting = false;

        this.currentIndex++;
        if (this.currentIndex >= this.nodes.length) {
            console.error('[Lavalink] Exhausted all nodes. Restarting cycle in 30s...');
            this.currentIndex = 0;
            this.scheduleReconnect(30000);
            return;
        }
        this.scheduleReconnect(2000);
    }

    scheduleReconnect(ms) {
        this.clearReconnect();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.tryConnect().catch(e => console.error('[Lavalink] tryConnect error:', e.message));
        }, ms);
    }

    clearReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    schedulePrimaryRetry() {
        this.clearPrimaryRetry();
        if (this.currentIndex === 0) return;
        this.primaryRetryTimer = setTimeout(() => {
            console.log('[Lavalink] Retrying primary node...');
            const wasIndex = this.currentIndex;
            this.currentIndex = 0;
            this.isConnecting = false;
            this.tryConnect().catch(() => {
                this.currentIndex = wasIndex;
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.schedulePrimaryRetry();
                }
            });
        }, 300000);
    }

    clearPrimaryRetry() {
        if (this.primaryRetryTimer) {
            clearTimeout(this.primaryRetryTimer);
            this.primaryRetryTimer = null;
        }
    }

    clearDeadline() {
        if (this.connectionDeadline) {
            clearTimeout(this.connectionDeadline);
            this.connectionDeadline = null;
        }
    }

    on(event, listener) {
        this.listeners.set(event, listener);
    }

    emit(event, data) {
        const listener = this.listeners.get(event);
        if (listener) listener(data);
    }

    async loadTracks(identifier) {
        const node = this.current;
        if (!node) throw new Error('No Lavalink node available');
        if (!this.sessionId) throw new Error('No active Lavalink session');

        const url = `${this.buildRestUrl(node)}/loadtracks?identifier=${encodeURIComponent(identifier)}`;

        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;
            const req = protocol.get(url, {
                headers: { Authorization: node.password },
                timeout: 15000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 500) {
                        this.moveToNextNode();
                        reject(new Error(`Lavalink HTTP ${res.statusCode} — switching node`));
                    } else if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    } else {
                        try { resolve(JSON.parse(data)); }
                        catch (e) { reject(new Error('Invalid JSON from Lavalink')); }
                    }
                });
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('REST timeout')); });
            req.on('error', reject);
        });
    }

    async updatePlayer(guildId, track, voiceState, options = {}) {
        if (!this.sessionId) throw new Error('Session ID not set');
        const node = this.current;
        const url = `${this.buildRestUrl(node)}/sessions/${this.sessionId}/players/${guildId}`;

        const payload = { voice: voiceState };
        if (track) payload.track = { encoded: track.encoded };
        if (options.volume !== undefined) payload.volume = options.volume;
        if (options.paused !== undefined) payload.paused = options.paused;
        if (options.filters !== undefined) payload.filters = options.filters;

        return this.makeRequest(url, 'PATCH', payload, node);
    }

    async updatePlayerProperties(guildId, properties = {}) {
        if (!this.sessionId) throw new Error('Session ID not set');
        const node = this.current;
        const url = `${this.buildRestUrl(node)}/sessions/${this.sessionId}/players/${guildId}`;

        const payload = {};
        if (properties.volume !== undefined) payload.volume = properties.volume;
        if (properties.paused !== undefined) payload.paused = properties.paused;
        if (properties.filters !== undefined) payload.filters = properties.filters;
        if (properties.position !== undefined) payload.position = properties.position;

        return this.makeRequest(url, 'PATCH', payload, node);
    }

    async destroyPlayer(guildId) {
        if (!this.sessionId) throw new Error('Session ID not set');
        const node = this.current;
        const url = `${this.buildRestUrl(node)}/sessions/${this.sessionId}/players/${guildId}`;

        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;
            const urlObj = new URL(url);

            const req = protocol.request({
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname,
                method: 'DELETE',
                headers: { Authorization: node.password },
                timeout: 10000
            }, (res) => {
                resolve(res.statusCode === 204 || res.statusCode === 200);
            });

            req.on('timeout', () => { req.destroy(); reject(new Error('Destroy timeout')); });
            req.on('error', reject);
            req.end();
        });
    }

    makeRequest(url, method, body, node) {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;
            const urlObj = new URL(url);

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname,
                method: method,
                headers: {
                    Authorization: node.password,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            };

            const req = protocol.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 500) {
                        this.moveToNextNode();
                        reject(new Error(`Lavalink HTTP ${res.statusCode} — switching node`));
                    } else if (res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    } else {
                        try { resolve(data ? JSON.parse(data) : {}); }
                        catch (e) { resolve({}); }
                    }
                });
            });

            req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
            req.on('error', reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }
}

module.exports = Lavalink;
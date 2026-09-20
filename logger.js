const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function formatMessage(args) {
    return args.map(arg => {
        if (typeof arg === 'object') {
            try {
                return arg instanceof Error ? arg.stack || arg.message : JSON.stringify(arg, null, 2);
            } catch (e) {
                return '[Circular Object or Error stringifying]';
            }
        }
        return String(arg);
    }).join(' ');
}

function sendToWebhook(content, type) {
    const webhookUrl = process.env.WEBHOOK;
    if (!webhookUrl) return;

    const colors = {
        log: 0x3498db,
        warn: 0xf1c40f,
        error: 0xe74c3c
    };

    let title = 'Terminal Log';
    if (type === 'warn') title = 'Terminal Warning';
    if (type === 'error') title = 'Terminal Error';

    let description = content;
    if (description.length > 4000) {
        description = description.substring(0, 4000) + '\n...[TRUNCATED]';
    }

    const payload = {
        embeds: [{
            title: title,
            description: `\`\`\`js\n${description}\n\`\`\``,
            color: colors[type],
            timestamp: new Date().toISOString()
        }]
    };

    const https = require('https');
    const { URL } = require('url');

    try {
        const payloadStr = JSON.stringify(payload);
        const parsedUrl = new URL(webhookUrl);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payloadStr)
            }
        };

        const req = https.request(options, (res) => {});

        req.on('error', (err) => {
            originalError('Failed to send log to webhook:', err.message);
        });

        req.write(payloadStr);
        req.end();
    } catch (err) {
        originalError('Failed to send log to webhook url error:', err.message);
    }
}

function initLogger() {
    console.log = function (...args) {
        originalLog.apply(console, args);
        sendToWebhook(formatMessage(args), 'log');
    };

    console.error = function (...args) {
        originalError.apply(console, args);
        sendToWebhook(formatMessage(args), 'error');
    };

    console.warn = function (...args) {
        originalWarn.apply(console, args);
        sendToWebhook(formatMessage(args), 'warn');
    };
}

module.exports = { initLogger };
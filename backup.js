const fs = require('fs');
const path = require('path');

function getStorageDir() {
    if (process.env.DATA_DIR) {
        if (!fs.existsSync(process.env.DATA_DIR)) {
            fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
        }
        return process.env.DATA_DIR;
    }
    if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
        return '/data';
    }
    const local = path.join(__dirname, 'data');
    if (!fs.existsSync(local)) {
        fs.mkdirSync(local, { recursive: true });
    }
    return local;
}

function getTokensFilePath() {
    return path.join(getStorageDir(), 'tokens.json');
}

function loadStoredTokens() {
    try {
        const file = getTokensFilePath();
        if (!fs.existsSync(file)) return {};
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) return {};
        return JSON.parse(raw);
    } catch (e) {
        console.error('[TokenStore] Failed to load tokens file:', e.message);
        return {};
    }
}

function saveStoredTokens(data) {
    try {
        const file = getTokensFilePath();
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        console.error('[TokenStore] Failed to save tokens file:', e.message);
        return false;
    }
}

function addStoredToken(key, token) {
    const data = loadStoredTokens();
    data[key] = token;
    return saveStoredTokens(data);
}

function removeStoredToken(key) {
    const data = loadStoredTokens();
    if (data[key]) {
        delete data[key];
        return saveStoredTokens(data);
    }
    return false;
}

function listStoredTokens() {
    const data = loadStoredTokens();
    return Object.entries(data).map(([key, token]) => ({ key, token }));
}

module.exports = {
    getStorageDir,
    getTokensFilePath,
    loadStoredTokens,
    saveStoredTokens,
    addStoredToken,
    removeStoredToken,
    listStoredTokens
};
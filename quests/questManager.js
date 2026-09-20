const { Quest } = require('./quest');

const HEARTBEAT_INTERVAL = 20000;
const VIDEO_REQUEST_INTERVAL = 15000;
const LIVE_UPDATE_INTERVAL = 5000;
const SYNC_INTERVAL = 30000;
const MAX_WORKERS = 3;
const VIDEO_SPEED = 15;
const VIDEO_MAX_FUTURE = 60;
const ENROLL_DELAY_MIN = 500;
const ENROLL_DELAY_MAX = 1000;
const ACTION_DELAY = 15000;

const SUPPORTED_TASKS = [
    'WATCH_VIDEO',
    'WATCH_VIDEO_ON_MOBILE',
    'PLAY_ON_DESKTOP',
    'STREAM_ON_DESKTOP',
    'PLAY_ACTIVITY',
];

const VIDEO_TASKS = new Set(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);

function sleep(ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
    });
}

function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
}

class QuestManager {
    constructor(client, quests, workerAPI) {
        this.client = client;
        this.quests = quests;
        this.api = workerAPI;
        this.logger = (msg) => console.log(msg);
        this.stopped = false;
        this.abortControllers = new Set();
        this.completedIds = new Set();
        this.questMap = new Map();
        this.retryCounts = new Map();
        this.liveUpdaterActive = false;
        this.currentProxy = null;
    }

    setLogger(fn) { this.logger = fn; }

    log(questId, msg) {
        let prefix = '';
        if (typeof questId === 'string' && msg) {
            const q = this.get(questId);
            const name = q ? (q.config.messages.quest_name || q.config.application.name) : questId;
            prefix = `[${name}] `;
        } else {
            msg = questId;
        }
        this.logger(`${prefix}${msg}`);
    }

    static fromResponse(client, response, workerAPI) {
        const quests = response.quests.map(q => Quest.create(q));
        return new QuestManager(client, quests, workerAPI);
    }

    list() { return this.quests; }
    get(questId) { return this.quests.find(q => q.id === questId); }

    filterQuestsValid() {
        return this.list().filter(q => !q.isCompleted() && !q.isExpired());
    }

    async enroll(quest) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await this.api.post(`/quests/${quest.id}/enroll`, {
                    location: 11,
                    is_targeted: false,
                    metadata_raw: null,
                    metadata_sealed: null,
                    traffic_metadata_raw: quest.data.traffic_metadata_raw,
                    traffic_metadata_sealed: quest.data.traffic_metadata_sealed,
                });

                if (res.status === 429) {
                    let wait = 3;
                    if (res.body && res.body.retry_after) wait = res.body.retry_after;
                    this.log(quest.id, `Rate limit enroll – waiting ${wait}s`);
                    await sleep(wait * 1000);
                    continue;
                }
                if (res.status === 200 || res.status === 201 || res.status === 204) {
                    this.log(quest.id, `✅ Enrolled`);
                    if (res.body) quest.updateUserStatus(res.body);
                    return true;
                }
                if (res.status === 404) {
                    this.log(quest.id, `Enroll: 404 Not Found (expired), skipping`);
                    return false;
                }
                if (res.status === 403) {
                    this.log(quest.id, `Enroll: 403 Forbidden, skipping`);
                    return false;
                }
                this.log(quest.id, `Enroll attempt ${attempt}/3 failed (${res.status})`);
                if (attempt < 3) await sleep(1000);
            } catch (e) {
                this.log(quest.id, `Enroll error ${attempt}/3: ${e.message}`);
                if (attempt < 3) await sleep(1000);
            }
        }
        return false;
    }

    async heartbeat(questId, applicationId, terminal = false) {
        return this.api.post(`/quests/${questId}/heartbeat`, {
            application_id: applicationId,
            terminal,
        });
    }

    async videoProgress(questId, timestamp) {
        return this.api.post(`/quests/${questId}/video-progress`, {
            timestamp: Math.round(timestamp * 100) / 100,
        }, {
            'Referer': `https://discord.com/quests/${questId}`,
        });
    }

    sleep(ms) {
        return new Promise((resolve, reject) => {
            if (this.stopped) return reject(new Error('Stopped'));
            const timer = setTimeout(resolve, ms);
            const cancel = () => {
                clearTimeout(timer);
                reject(new Error('Stopped'));
            };
            this.abortControllers.add(cancel);
            setTimeout(() => this.abortControllers.delete(cancel), ms);
        });
    }

    async verifyProgress(questId) {
        try {
            const res = await this.api.get('/quests/@me');
            if (res.status !== 200) return null;
            const remoteQuest = (res.body.quests || []).find(q => q.id === questId);
            return remoteQuest?.user_status?.progress;
        } catch (e) {
            return null;
        }
    }

    async runVideo(quest, taskConfig, taskName) {
        const name = quest.config.messages?.quest_name || quest.config.application?.name || quest.id;
        const target = taskConfig.target;
        let current = quest.userStatus?.progress?.[taskName]?.value || 0;

        const altTask = taskName === 'WATCH_VIDEO' ? 'WATCH_VIDEO_ON_MOBILE' : 'WATCH_VIDEO';
        const config = quest.config.task_config || quest.config.task_config_v2;
        const hasAlt = config?.tasks?.[altTask] !== undefined;

        if (target <= 0) {
            this.log(quest.id, `seconds_needed=0, skipping`);
            return false;
        }

        if (this.questMap.has(quest.id)) {
            this.questMap.get(quest.id).secondsDone = current;
            this.questMap.get(quest.id).secondsNeeded = target;
        }

        const enrolledAtStr = quest.userStatus?.enrolled_at;
        let enrolledTs;
        if (enrolledAtStr) {
            try {
                enrolledTs = new Date(enrolledAtStr).getTime() / 1000;
            } catch (e) {
                enrolledTs = Date.now() / 1000 - current;
            }
        } else {
            enrolledTs = Date.now() / 1000 - current;
        }

        this.log(quest.id, `Video: ${name} (${Math.floor(current)}/${target}s, type=${taskName})`);

        const sendProgress = async (ts, useTask) => {
            try {
                const r = await this.videoProgress(quest.id, ts);
                if (r.status === 200) {
                    const body = r.body;
                    const progress = body.progress || {};
                    let updated = current;
                    for (const key of [useTask, 'WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']) {
                        if (progress[key]) {
                            const val = progress[key];
                            updated = typeof val === 'object' ? (val.value || updated) : val;
                            break;
                        }
                    }
                    if (updated === current && ts > current) updated = Math.max(current, ts);
                    current = updated;
                    if (this.questMap.has(quest.id)) {
                        this.questMap.get(quest.id).secondsDone = updated;
                    }
                    this.log(quest.id, `${name}: ${Math.floor(updated)}/${target}s`);
                    const completed = Boolean(body.completed_at);
                    return { updated, completed, bail: false };
                } else if (r.status === 429) {
                    let wait = 5;
                    try { wait = r.body?.retry_after || 5; } catch (e) {}
                    this.log(quest.id, `Rate limit video – waiting ${Math.floor(wait)}s`);
                    await sleep((wait + 1) * 1000);
                    return { updated: current, completed: false, bail: false };
                } else if (r.status === 404) {
                    this.log(quest.id, `Video 404`);
                    return { updated: current, completed: false, bail: true };
                } else if (r.status === 400) {
                    return { updated: current, completed: false, bail: false };
                } else {
                    return { updated: current, completed: false, bail: false };
                }
            } catch (e) {
                return { updated: current, completed: false, bail: false };
            }
        };

        const doVideo = async (useTask) => {
            let localDone = current;

            if (!this.stopped) {
                const r = await sendProgress(target, useTask);
                localDone = r.updated;
                if (r.bail) return false;
                if (r.completed) return true;
            }

            this.log(quest.id, `Step [${useTask}]: ${Math.floor(localDone)}s → ${target}s`);

            while (localDone < target && !this.stopped) {
                const elapsed = Date.now() / 1000 - enrolledTs;
                const maxAllowed = elapsed + VIDEO_MAX_FUTURE;
                const nextTs = localDone + VIDEO_SPEED;

                if (nextTs > maxAllowed && nextTs < target) {
                    await this.sleep(VIDEO_REQUEST_INTERVAL).catch(() => {});
                    continue;
                }

                const sendTs = Math.min(nextTs + Math.random() * 0.5, target);
                const r = await sendProgress(sendTs, useTask);
                localDone = r.updated;

                if (r.bail) return false;
                if (r.completed) return true;

                if (localDone < sendTs - 1) {
                    localDone = Math.min(sendTs, target);
                    current = localDone;
                    if (this.questMap.has(quest.id)) {
                        this.questMap.get(quest.id).secondsDone = localDone;
                    }
                }

                if (localDone >= target) break;
                await this.sleep(VIDEO_REQUEST_INTERVAL).catch(() => {});
            }

            if (!this.stopped) {
                for (let i = 0; i < 3; i++) {
                    const r = await sendProgress(target, useTask);
                    if (r.completed) return true;
                    if (r.bail) break;
                    if (i < 2) await this.sleep(VIDEO_REQUEST_INTERVAL).catch(() => {});
                }
            }

            try {
                const r = await this.api.get('/quests/@me');
                if (r.status === 200) {
                    const ql = r.body.quests || [];
                    for (const q of ql) {
                        if (q.id === quest.id && q.user_status?.completed_at) return true;
                    }
                }
            } catch (e) {}

            return false;
        };

        if (await doVideo(taskName)) {
            this.log(quest.id, `✅ Video done [${taskName}]: ${name}`);
            if (this.questMap.has(quest.id)) {
                this.questMap.get(quest.id).secondsDone = target;
            }
            return true;
        }

        if (hasAlt && !this.stopped) {
            this.log(quest.id, `Trying fallback [${altTask}] for ${name}`);
            if (await doVideo(altTask)) {
                this.log(quest.id, `✅ Video done [${altTask}]: ${name}`);
                if (this.questMap.has(quest.id)) {
                    this.questMap.get(quest.id).secondsDone = target;
                }
                return true;
            }
        }

        this.log(quest.id, `⚠️ Video failed: ${name} (${Math.floor(current)}/${target}s)`);
        return false;
    }

    async runPlay(quest, taskConfig, taskName) {
        const appId = quest.config.application.id;
        const appName = quest.config.application.name;
        this.log(quest.id, `${taskName}: ${appName}`);

        const target = taskConfig.target;
        let current = quest.userStatus?.progress?.[taskName]?.value || 0;
        const pid = Math.floor(Math.random() * (30000 - 1000)) + 1000;

        if (this.questMap.has(quest.id)) {
            this.questMap.get(quest.id).secondsDone = current;
            this.questMap.get(quest.id).secondsNeeded = target;
        }

        while (current < target && !this.stopped) {
            try {
                const res = await this.heartbeat(quest.id, appId, false);

                if (res.status === 200) {
                    const body = res.body;
                    const prog = body.progress || {};
                    if (prog[taskName]) {
                        const val = prog[taskName];
                        current = typeof val === 'object' ? (val.value || current) : val;
                    }
                    const discordCompleted = Boolean(body.completed_at);
                    if (discordCompleted) current = target;
                    if (this.questMap.has(quest.id)) {
                        this.questMap.get(quest.id).secondsDone = current;
                    }
                    this.log(quest.id, `${appName}: ${Math.floor(current)}/${target}s`);
                    if (discordCompleted || current >= target) break;
                } else if (res.status === 429) {
                    const wait = res.body?.retry_after || 1;
                    await sleep(wait * 1000);
                    continue;
                } else if (res.status === 400 || res.status === 404) {
                    this.log(quest.id, `Quest invalid (${res.status}), skipping`);
                    break;
                }
            } catch (e) {
                this.log(quest.id, `Heartbeat error: ${e.message}`);
            }
            await sleep(HEARTBEAT_INTERVAL);
        }

        try {
            await this.heartbeat(quest.id, appId, true);
        } catch (e) {}

        const ok = current >= target;
        this.log(quest.id, ok ? `✅ Heartbeat done` : `⚠️ Heartbeat failed`);
        return ok;
    }

    async runActivity(quest, taskConfig, taskName) {
        const target = taskConfig.target;
        let current = quest.userStatus?.progress?.PLAY_ACTIVITY?.value || 0;
        const streamKey = 'call:0:1';

        if (this.questMap.has(quest.id)) {
            this.questMap.get(quest.id).secondsDone = current;
            this.questMap.get(quest.id).secondsNeeded = target;
        }

        while (current < target && !this.stopped) {
            try {
                const res = await this.api.post(`/quests/${quest.id}/heartbeat`, {
                    stream_key: streamKey,
                    terminal: false,
                });
                if (res.status === 200) {
                    const body = res.body;
                    const prog = body.progress || {};
                    if (prog.PLAY_ACTIVITY) {
                        const val = prog.PLAY_ACTIVITY;
                        current = typeof val === 'object' ? (val.value || current) : val;
                    }
                    const discordCompleted = Boolean(body.completed_at);
                    if (discordCompleted) current = target;
                    if (this.questMap.has(quest.id)) {
                        this.questMap.get(quest.id).secondsDone = current;
                    }
                    if (discordCompleted || current >= target) break;
                } else if (res.status === 429) {
                    const wait = res.body?.retry_after || 1;
                    await sleep(wait * 1000);
                    continue;
                } else if (res.status === 400 || res.status === 404) {
                    break;
                }
            } catch (e) {
                this.log(quest.id, `Activity error: ${e.message}`);
            }
            await sleep(HEARTBEAT_INTERVAL);
        }

        try {
            await this.api.post(`/quests/${quest.id}/heartbeat`, {
                stream_key: streamKey,
                terminal: true,
            });
        } catch (e) {}

        const ok = current >= target;
        this.log(quest.id, ok ? `✅ Activity done` : `⚠️ Activity failed`);
        return ok;
    }

    async doingQuest(quest) {
        if (this.stopped) return false;
        if (this.completedIds.has(quest.id)) return true;

        const config = quest.config.task_config || quest.config.task_config_v2;
        const tasks = config?.tasks;
        if (!tasks) return false;

        const taskName = Object.keys(tasks).find(k => SUPPORTED_TASKS.includes(k) && tasks[k]);
        if (!taskName) {
            this.log(quest.id, 'Unsupported task, skipping');
            return false;
        }

        this.log(quest.id, `━━━ ${quest.config.messages?.quest_name || quest.config.application?.name} (task: ${taskName}) ━━━`);

        if (!quest.isEnrolledQuest()) {
            this.log(quest.id, 'Enrolling...');
            const enrolled = await this.enroll(quest);
            if (!enrolled) return false;
        }

        let result = false;
        if (VIDEO_TASKS.has(taskName)) {
            result = await this.runVideo(quest, tasks[taskName], taskName);
        } else if (taskName === 'PLAY_ON_DESKTOP' || taskName === 'STREAM_ON_DESKTOP') {
            result = await this.runPlay(quest, tasks[taskName], taskName);
        } else if (taskName === 'PLAY_ACTIVITY') {
            result = await this.runActivity(quest, tasks[taskName], taskName);
        }

        if (result) {
            this.completedIds.add(quest.id);
            this.retryCounts.delete(quest.id);
            if (this.questMap.has(quest.id)) {
                this.questMap.get(quest.id).status = 'done';
            }
        } else {
            const retries = (this.retryCounts.get(quest.id) || 0) + 1;
            this.retryCounts.set(quest.id, retries);
            if (this.questMap.has(quest.id)) {
                this.questMap.get(quest.id).status = 'failed';
            }
        }

        return result;
    }

    async startLiveUpdater(onUpdate) {
        if (this.liveUpdaterActive) return;
        this.liveUpdaterActive = true;

        const syncLoop = async () => {
            while (!this.stopped && this.liveUpdaterActive) {
                await sleep(SYNC_INTERVAL);
                if (this.stopped) break;
                try {
                    const res = await this.api.get('/quests/@me');
                    if (res.status !== 200) continue;
                    const remoteQuests = res.body.quests || [];
                    for (const q of remoteQuests) {
                        if (!this.questMap.has(q.id)) continue;
                        const info = this.questMap.get(q.id);
                        if (info.status === 'done' || info.status === 'failed') continue;
                        const cfg = q.config.task_config || q.config.task_config_v2;
                        const tasks = cfg?.tasks || {};
                        const tName = Object.keys(tasks).find(k => SUPPORTED_TASKS.includes(k));
                        if (!tName) continue;
                        const progress = q.user_status?.progress?.[tName];
                        const realDone = progress ? (typeof progress === 'object' ? (progress.value || 0) : progress) : 0;
                        const realNeeded = tasks[tName]?.target || 0;
                        if (q.user_status?.completed_at) {
                            info.secondsDone = realNeeded > 0 ? realNeeded : realDone;
                            info.status = 'done';
                        } else {
                            if (realDone > 0) info.secondsDone = realDone;
                            if (realNeeded > 0) info.secondsNeeded = realNeeded;
                        }
                    }
                } catch (e) {}
            }
        };

        const updateLoop = async () => {
            while (!this.stopped && this.liveUpdaterActive) {
                await sleep(LIVE_UPDATE_INTERVAL);
                if (this.stopped) break;
                if (onUpdate && this.questMap.size > 0) {
                    onUpdate(this.questMap);
                }
            }
        };

        syncLoop();
        updateLoop();
    }

    stopAll() {
        this.stopped = true;
        this.liveUpdaterActive = false;
        this.abortControllers.forEach(cancel => cancel());
        this.abortControllers.clear();
    }
}

module.exports = { QuestManager };
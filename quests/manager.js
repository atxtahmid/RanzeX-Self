const { ClientQuest, WorkerAPI, fetchBuildNumber } = require('./client');

const POLL_INTERVAL = 5000;
const MAX_WORKERS = 3;
const ACTION_DELAY = 15000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class QuestManagerBridge {
    constructor(token) {
        this.token = token.replace('Bot ', '');
        this.client = new ClientQuest(this.token);

        this.client.connect().catch(err => {
            this.log('system', `Gateway Error: ${err.message}`);
        });

        this.globalLogs = [];
        this.activeManager = null;
        this.isRunning = false;
        this.questMap = new Map();
        this.completedIds = new Set();
        this.liveUpdateCallback = null;
        this.currentProxy = null;
        this.workerAPI = null;
        this.buildNumber = 0;
        this.countries = [];
        this.proxyManager = null;
    }

    get activeQuests() { return this.questMap; }

    setLiveUpdateCallback(fn) {
        this.liveUpdateCallback = fn;
    }

    setProxyManager(pm, countries) {
        this.proxyManager = pm;
        this.countries = countries || [];
    }

    log(questId, msg) {
        let line = msg || questId;
        const time = new Date().toLocaleTimeString();
        if (!line.startsWith('[')) {
            line = `[${time}] ${line}`;
        }
        this.globalLogs.push(line);
        if (this.globalLogs.length > 500) this.globalLogs.shift();
    }

    clearLogs() {
        this.globalLogs = [];
        this.log('system', 'Logs cleared.');
    }

    async startAll() {
        if (this.isRunning) {
            this.log('system', 'Already running.');
            return;
        }

        this.isRunning = true;
        this.log('system', 'Starting Quest Protocol...');

        try {
            this.buildNumber = await fetchBuildNumber();
            this.log('system', `Build: ${this.buildNumber}`);

            this.workerAPI = new WorkerAPI(this.token, this.buildNumber, null);

            const countries = [null];
            if (this.countries.length > 0) {
                for (const c of this.countries) {
                    if (!countries.includes(c)) countries.push(c);
                }
            }

            const { QuestManager } = require('./questManager');
            const firstRes = await this.workerAPI.get('/quests/@me');
            if (firstRes.status !== 200) {
                this.log('system', `Failed to fetch quests: ${firstRes.status}`);
                this.isRunning = false;
                return;
            }

            let manager = QuestManager.fromResponse(this.client, firstRes.body, this.workerAPI);
            manager.setLogger((msg) => this.log(msg));
            this.activeManager = manager;

            let cycle = 0;
            let notifiedStart = false;
            let completionSent = false;

            while (!manager.stopped) {
                cycle++;
                this.log('system', `── Scan #${cycle} ──`);

                for (const country of countries) {
                    if (manager.stopped) break;

                    let proxy = null;
                    if (country !== null && this.proxyManager) {
                        proxy = this.proxyManager.getProxyForCountry(country);
                        if (!proxy) {
                            this.log('system', `No proxy for ${country}, skipping`);
                            continue;
                        }
                    }

                    const api = new WorkerAPI(this.token, this.buildNumber, proxy);
                    manager.api = api;

                    const res = await api.get('/quests/@me');
                    if (res.status !== 200) {
                        this.log('system', `[${country || 'direct'}] Fetch failed: ${res.status}`);
                        continue;
                    }

                    const quests = res.body.quests || [];
                    manager.quests = quests.map(q => require('./quest').Quest.create(q));

                    if (quests.length > 0) {
                        const enrolled = quests.filter(q => q.user_status?.enrolled_at).length;
                        const completed = quests.filter(q => q.user_status?.completed_at).length;
                        const completable = quests.filter(q => {
                            const cfg = q.config.task_config || q.config.task_config_v2;
                            const tasks = cfg?.tasks || {};
                            return Object.keys(tasks).some(k => ['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE', 'PLAY_ON_DESKTOP', 'STREAM_ON_DESKTOP', 'PLAY_ACTIVITY'].includes(k) && tasks[k]);
                        }).length;

                        this.log('system', `[${country || 'direct'}] Total: ${quests.length} | Enrolled: ${enrolled} | Completed: ${completed} | Completable: ${completable}`);

                        await this.processQuestList(manager, quests);
                    } else {
                        this.log('system', `[${country || 'direct'}] No quests`);
                    }

                    if (!notifiedStart) {
                        notifiedStart = true;
                        manager.startLiveUpdater((map) => {
                            this.questMap = map;
                            if (this.liveUpdateCallback) this.liveUpdateCallback(map);
                        });
                    }
                }

                const hasPending = Array.from(manager.questMap.values()).some(
                    v => v.status === 'waiting' || v.status === 'running' || v.status === 'enrolling'
                );

                if (!hasPending && !completionSent) {
                    this.log('system', '✅ No more actionable quests. Stopping worker.');
                    completionSent = true;
                    manager.stopAll();
                    break;
                }

                for (let i = 0; i < POLL_INTERVAL / 1000; i++) {
                    if (manager.stopped) break;
                    await sleep(1000);
                }
            }

        } catch (error) {
            this.log('system', `Critical Error: ${error.message}`);
        } finally {
            this.isRunning = false;
            this.activeManager = null;
        }
    }

    async runWithConcurrency(tasks, limit, manager) {
        const executing = new Set();
        const results = [];

        for (const task of tasks) {
            if (manager.stopped) break;

            while (executing.size >= limit) {
                await Promise.race(executing);
            }

            const p = (async () => {
                try {
                    const r = await task();
                    results.push(r);
                } catch (e) {
                    results.push({ error: e.message });
                } finally {
                    executing.delete(p);
                }
            })();
            executing.add(p);
        }

        if (executing.size > 0) {
            await Promise.all(executing);
        }
        return results;
    }

    async processQuestList(manager, quests) {
        const SUPPORTED = ['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE', 'PLAY_ON_DESKTOP', 'STREAM_ON_DESKTOP', 'PLAY_ACTIVITY'];
        const VIDEO_TASKS = new Set(['WATCH_VIDEO', 'WATCH_VIDEO_ON_MOBILE']);

        const getTaskName = (q) => {
            const cfg = q.config.task_config || q.config.task_config_v2;
            const tasks = cfg?.tasks || {};
            return Object.keys(tasks).find(k => SUPPORTED.includes(k) && tasks[k]);
        };

        const getTarget = (q, taskName) => {
            const cfg = q.config.task_config || q.config.task_config_v2;
            const t = cfg?.tasks?.[taskName];
            return t && t.target ? parseFloat(t.target) : 0;
        };

        for (const q of quests) {
            const cfg = q.config.task_config || q.config.task_config_v2;
            if (!cfg?.tasks) continue;
            const taskName = getTaskName(q);
            if (!taskName) continue;
            const qid = q.id;
            if (!manager.questMap.has(qid)) {
                manager.questMap.set(qid, {
                    name: q.config.messages?.quest_name || q.config.application?.name || qid,
                    status: 'waiting',
                    secondsDone: q.user_status?.progress?.[taskName]?.value || 0,
                    secondsNeeded: getTarget(q, taskName),
                    taskType: taskName,
                });
            }
            if (q.user_status?.completed_at) {
                manager.questMap.get(qid).status = 'done';
            }
        }

        const unaccepted = quests.filter(q => {
            const enrolled = !!q.user_status?.enrolled_at;
            const completed = !!q.user_status?.completed_at;
            const cfg = q.config.task_config || q.config.task_config_v2;
            const tasks = cfg?.tasks || {};
            const completable = Object.keys(tasks).some(k => SUPPORTED.includes(k) && tasks[k]);
            return !enrolled && !completed && completable;
        });

        if (unaccepted.length > 0) {
            this.log('system', `Auto-enrolling ${unaccepted.length} quests (sequential, ~2s each)...`);
            for (let i = 0; i < unaccepted.length; i++) {
                const q = unaccepted[i];
                const taskName = getTaskName(q);
                this.log('system', `  → [${i + 1}/${unaccepted.length}] ${q.config.messages?.quest_name || q.config.application?.name} [${taskName}]`);
                if (manager.questMap.has(q.id)) {
                    manager.questMap.get(q.id).status = 'enrolling';
                }
                await manager.enroll(q);
                if (manager.questMap.has(q.id)) {
                    manager.questMap.get(q.id).status = 'waiting';
                }
                if (i < unaccepted.length - 1) {
                    await sleep(500 + Math.random() * 500);
                }
            }
        }

        const actionable = quests.filter(q => {
            const enrolled = !!q.user_status?.enrolled_at;
            const completed = !!q.user_status?.completed_at;
            const expired = q.config.expires_at && new Date(q.config.expires_at).getTime() < Date.now();
            if (!enrolled || completed || expired) return false;
            if (manager.completedIds.has(q.id)) return false;
            const cfg = q.config.task_config || q.config.task_config_v2;
            const tasks = cfg?.tasks || {};
            return Object.keys(tasks).some(k => SUPPORTED.includes(k) && tasks[k]);
        });

        if (actionable.length === 0) return;

        const videoQuests = actionable.filter(q => VIDEO_TASKS.has(getTaskName(q)));
        const otherQuests = actionable.filter(q => !VIDEO_TASKS.has(getTaskName(q)));
        const ordered = [...videoQuests, ...otherQuests];

        this.log('system', `${actionable.length} quest(s) to do (video=${videoQuests.length}, game=${otherQuests.length}) — max ${MAX_WORKERS} concurrent`);

        for (const q of ordered) {
            if (manager.questMap.has(q.id)) {
                manager.questMap.get(q.id).status = 'running';
            }
        }

        const runOne = (q, index) => async () => {
            if (manager.stopped) return;
            if (index > 0) {
                await sleep(Math.min(ACTION_DELAY * index, 30000));
            }
            if (manager.stopped) return;
            await manager.doingQuest(q);
        };

        if (videoQuests.length > 0 && !manager.stopped) {
            this.log('system', `▶ PHASE 1: ${videoQuests.length} video quest(s)`);
            const tasks = videoQuests.map((q, i) => runOne(q, i));
            await this.runWithConcurrency(tasks, MAX_WORKERS, manager);
            this.log('system', '✅ PHASE 1 done');
        }

        if (otherQuests.length > 0 && !manager.stopped) {
            const remaining = otherQuests.filter(q => !manager.completedIds.has(q.id));
            if (remaining.length > 0) {
                this.log('system', `▶ PHASE 2: ${remaining.length} game quest(s)`);
                const tasks = remaining.map((q, i) => runOne(q, i));
                await this.runWithConcurrency(tasks, MAX_WORKERS, manager);
                this.log('system', '✅ PHASE 2 done');
            }
        }

        const completedCount = ordered.filter(q => manager.completedIds.has(q.id)).length;
        this.log('system', `Completed ${completedCount} quest(s)`);
    }

    stopAll() {
        if (this.activeManager) {
            this.activeManager.stopAll();
            this.log('system', 'Stopping all tasks immediately...');
        } else {
            this.log('system', 'Nothing to stop.');
        }
        this.isRunning = false;
    }
}

module.exports = QuestManagerBridge;
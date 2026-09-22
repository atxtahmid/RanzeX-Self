const { ClientQuest, WorkerAPI, fetchBuildNumber } = require('./client');

const POLL_INTERVAL = 5000;

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

        const actionable = quests.filter(q => {
            const completed = !!q.user_status?.completed_at;
            const expired = q.config.expires_at && new Date(q.config.expires_at).getTime() < Date.now();
            if (completed || expired) return false;
            if (manager.completedIds.has(q.id)) return false;
            const cfg = q.config.task_config || q.config.task_config_v2;
            const tasks = cfg?.tasks || {};
            return Object.keys(tasks).some(k => SUPPORTED.includes(k) && tasks[k]);
        });

        if (actionable.length === 0) return;

        const enrolledNow = actionable.filter(q => !!q.user_status?.enrolled_at);
        const needEnroll = actionable.filter(q => !q.user_status?.enrolled_at);

        const sortByType = (arr) => {
            const vids = arr.filter(q => VIDEO_TASKS.has(getTaskName(q)));
            const games = arr.filter(q => !VIDEO_TASKS.has(getTaskName(q)));
            return [...vids, ...games];
        };

        const ordered = [...sortByType(enrolledNow), ...sortByType(needEnroll)];

        this.log('system', `${ordered.length} quest(s) to process (${enrolledNow.length} enrolled, ${needEnroll.length} need enroll)`);

        let enrolledCount = 0;
        let completedCount = 0;
        let failedCount = 0;
        let hitRateLimit = false;

        for (let i = 0; i < ordered.length; i++) {
            if (manager.stopped || hitRateLimit) break;

            const q = ordered[i];
            const taskName = getTaskName(q);
            const name = q.config.messages?.quest_name || q.config.application?.name || q.id;
            const progress = `[${i + 1}/${ordered.length}]`;

            const isEnrolled = !!q.user_status?.enrolled_at;

            if (!isEnrolled) {
                if (manager.questMap.has(q.id)) {
                    manager.questMap.get(q.id).status = 'enrolling';
                }

                const beforeLogs = this.globalLogs.length;
                const ok = await manager.enroll(q);
                const newLogs = this.globalLogs.slice(beforeLogs);

                if (!ok) {
                    const wasRateLimited = newLogs.some(l => l.includes('Rate limit'));
                    if (wasRateLimited) {
                        this.log('system', `${progress} ${name} [${taskName}] — ⏳ rate limited, halting phase`);
                        if (manager.questMap.has(q.id)) {
                            manager.questMap.get(q.id).status = 'waiting';
                        }
                        hitRateLimit = true;
                        break;
                    }
                    failedCount++;
                    if (manager.questMap.has(q.id)) {
                        manager.questMap.get(q.id).status = 'failed';
                    }
                    this.log('system', `${progress} ${name} [${taskName}] — ❌ enroll failed`);
                    continue;
                }

                enrolledCount++;
                q.user_status = q.user_status || {};
                q.user_status.enrolled_at = new Date().toISOString();

                if (manager.questMap.has(q.id)) {
                    manager.questMap.get(q.id).status = 'running';
                }

                this.log('system', `${progress} ${name} [${taskName}] — ✅ enrolled`);
                await sleep(3000);
            }

            if (manager.questMap.has(q.id)) {
                manager.questMap.get(q.id).status = 'running';
            }

            const ok = await manager.doingQuest(q);
            if (ok) {
                completedCount++;
                this.log('system', `${progress} ${name} [${taskName}] — 🎉 completed`);
            } else {
                failedCount++;
                this.log('system', `${progress} ${name} [${taskName}] — ⚠️ completion failed`);
            }

            if (i < ordered.length - 1 && !manager.stopped && !hitRateLimit) {
                await sleep(3000);
            }
        }

        this.log('system', `Scan summary: enrolled=${enrolledCount}, completed=${completedCount}, failed=${failedCount}${hitRateLimit ? ' (stopped early on rate limit)' : ''}`);
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
const https = require('https');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry(fn, log, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (error.httpStatus === 429 || error.status === 429 || error.message?.includes('rate limit')) {
                const retryAfter = (error.retryAfter || error.retry_after || 10) * 1000;
                const waitTime = retryAfter + (Math.random() * 2000);
                log(`⏳ Rate limited! Waiting ${(waitTime / 1000).toFixed(1)}s before retrying...`);
                await delay(waitTime);
            } else {
                throw error;
            }
        }
    }
    throw new Error(`Max retries (${maxRetries}) reached for rate limit.`);
}

async function downloadImage(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const base64 = buffer.toString('base64');
                const mimeType = res.headers['content-type'] || 'image/png';
                resolve(`data:${mimeType};base64,${base64}`);
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

class ServerCloner {
    constructor(client, logCallback) {
        this.client = client;
        this.log = logCallback || (() => { });
        this.roleMapping = new Map();
        this.stats = {
            rolesCreated: 0,
            categoriesCreated: 0,
            channelsCreated: 0,
            emojisCreated: 0,
            failed: 0
        };
        this.stopped = false;
    }

    stop() {
        this.stopped = true;
        this.log('🛑 Stop signal received. Halting process...');
    }

    async cloneServer(sourceGuildId, targetGuildId, options = {}) {
        try {
            const sourceGuild = this.client.guilds.cache.get(sourceGuildId);
            const targetGuild = this.client.guilds.cache.get(targetGuildId);

            if (!sourceGuild) throw new Error('Source server not found or bot is not a member.');
            if (!targetGuild) throw new Error('Target server not found or bot is not a member.');

            this.log(`Cloning from: ${sourceGuild.name} -> ${targetGuild.name}`);
            this.log('Starting cloning process...');

            const opts = {
                deleteChannels: options.deleteChannels !== false,
                deleteRoles: options.deleteRoles !== false,
                deleteEmojis: options.deleteEmojis === true,
                cloneChannels: options.cloneChannels !== false,
                cloneRoles: options.cloneRoles !== false,
                cloneEmojis: options.cloneEmojis === true,
                updateInfo: options.updateInfo === true
            };

            await this.deleteExistingContent(targetGuild, opts);

            if (opts.cloneRoles) await this.cloneRoles(sourceGuild, targetGuild);
            if (opts.cloneChannels) {
                await this.cloneCategories(sourceGuild, targetGuild);
                await this.cloneChannels(sourceGuild, targetGuild);
            }

            if (opts.cloneEmojis && !this.stopped) await this.cloneEmojis(sourceGuild, targetGuild);
            if (opts.updateInfo && !this.stopped) await this.cloneServerInfo(sourceGuild, targetGuild);

            if (this.stopped) {
                this.log(`⚠️ Cloning stopped by user.`);
                return this.stats;
            }

            this.log(`🎉 Cloning completed! Success Rate: ${this.getSuccessRate()}%`);
            return this.stats;

        } catch (error) {
            this.log(`❌ Cloning failed: ${error.message}`);
            throw error;
        }
    }

    getSuccessRate() {
        const total = this.stats.rolesCreated + this.stats.categoriesCreated +
            this.stats.channelsCreated + this.stats.emojisCreated;
        return Math.round((total / (total + this.stats.failed)) * 100) || 0;
    }

    async deleteExistingContent(guild, opts) {
        this.log('🗑️  Cleaning target server...');

        if (opts.deleteChannels) {
            const channels = guild.channels.cache.filter(ch => ch.deletable);
            for (const [, channel] of channels) {
                if (this.stopped) return;
                try {
                    await withRetry(() => channel.delete(), this.log);
                    this.log(`Deleted channel: ${channel.name}`);
                    await delay(2000);
                } catch (error) {
                    this.log(`Failed to delete channel ${channel.name}: ${error.message}`);
                    this.stats.failed++;
                }
            }
        }

        if (opts.deleteRoles) {
            const roles = guild.roles.cache.filter(role => role.name !== '@everyone' && !role.managed && role.editable);
            for (const [, role] of roles) {
                if (this.stopped) return;
                try {
                    await withRetry(() => role.delete(), this.log);
                    this.log(`Deleted role: ${role.name}`);
                    await delay(2000);
                } catch (error) {
                    this.log(`Failed to delete role ${role.name}: ${error.message}`);
                    this.stats.failed++;
                }
            }
        }

        if (opts.deleteEmojis) {
            const emojis = guild.emojis.cache.filter(e => e.deletable);
            for (const [, emoji] of emojis) {
                if (this.stopped) return;
                try {
                    await withRetry(() => emoji.delete(), this.log);
                    this.log(`Deleted emoji: ${emoji.name}`);
                    await delay(2000);
                } catch (e) {
                    this.log(`Failed to delete emoji ${emoji.name}`);
                    this.stats.failed++;
                }
            }
        }

        this.log('Cleanup step finished.');
    }

    async cloneRoles(sourceGuild, targetGuild) {
        this.log('👑 Cloning roles...');
        const roles = sourceGuild.roles.cache
            .filter(role => role.name !== '@everyone' && !role.managed)
            .sort((a, b) => b.position - a.position);

        for (const [, role] of roles) {
            if (this.stopped) return;
            try {
                const newRole = await withRetry(() => targetGuild.roles.create({
                    name: role.name,
                    color: role.hexColor,
                    permissions: role.permissions,
                    hoist: role.hoist,
                    mentionable: role.mentionable,
                    reason: 'Server Cloner'
                }), this.log);
                
                this.roleMapping.set(role.id, newRole.id);
                this.log(`Created role: ${role.name}`);
                this.stats.rolesCreated++;
                await delay(2000);
            } catch (error) {
                this.log(`Failed to create role ${role.name}: ${error.message}`);
                this.stats.failed++;
            }
        }
    }

    async cloneCategories(sourceGuild, targetGuild) {
        this.log('📁 Cloning categories...');
        const categories = sourceGuild.channels.cache.filter(ch => ch.type === 'GUILD_CATEGORY').sort((a, b) => a.position - b.position);

        for (const [, category] of categories) {
            if (this.stopped) return;
            try {
                const overwrites = this.mapPermissionOverwrites(category.permissionOverwrites, targetGuild);
                await withRetry(() => targetGuild.channels.create(category.name, {
                    type: 'GUILD_CATEGORY',
                    permissionOverwrites: overwrites || [],
                    position: category.position,
                    reason: 'Server Cloner'
                }), this.log);
                
                this.log(`Created category: ${category.name}`);
                this.stats.categoriesCreated++;
                await delay(2000);
            } catch (error) {
                this.log(`Failed to create category ${category.name}: ${error.message}`);
                this.stats.failed++;
            }
        }
    }

    async cloneChannels(sourceGuild, targetGuild) {
        this.log('💬 Cloning channels...');
        const channels = sourceGuild.channels.cache.filter(ch => ch.type === 'GUILD_TEXT' || ch.type === 'GUILD_VOICE').sort((a, b) => a.position - b.position);

        for (const [, channel] of channels) {
            if (this.stopped) return;
            try {
                const overwrites = this.mapPermissionOverwrites(channel.permissionOverwrites, targetGuild);
                const parent = channel.parent ? targetGuild.channels.cache.find(c => c.name === channel.parent.name && c.type === 'GUILD_CATEGORY') : null;

                const opts = {
                    type: channel.type,
                    parent: parent?.id,
                    permissionOverwrites: overwrites || [],
                    position: channel.position,
                    reason: 'Server Cloner'
                };

                if (channel.type === 'GUILD_TEXT') {
                    opts.topic = channel.topic || '';
                    opts.nsfw = channel.nsfw;
                    opts.rateLimitPerUser = channel.rateLimitPerUser;
                } else if (channel.type === 'GUILD_VOICE') {
                    let bitrate = channel.bitrate;
                    if (targetGuild.maximumBitrate) {
                        bitrate = Math.min(bitrate, targetGuild.maximumBitrate);
                    } else {
                        bitrate = Math.min(bitrate, 96000);
                    }
                    opts.bitrate = bitrate;
                    opts.userLimit = channel.userLimit;
                }

                await withRetry(() => targetGuild.channels.create(channel.name, opts), this.log);
                
                this.log(`Created channel: ${channel.name}`);
                this.stats.channelsCreated++;
                await delay(2000);
            } catch (error) {
                this.log(`Failed to create channel ${channel.name}: ${error.message}`);
                this.stats.failed++;
            }
        }
    }

    async cloneEmojis(sourceGuild, targetGuild) {
        this.log('😀 Cloning emojis...');
        for (const [, emoji] of sourceGuild.emojis.cache) {
            if (this.stopped) return;
            try {
                const data = await downloadImage(emoji.url);
                await withRetry(() => targetGuild.emojis.create(data, emoji.name, { reason: 'Server Cloner' }), this.log);
                
                this.log(`Created emoji: ${emoji.name}`);
                this.stats.emojisCreated++;
                await delay(5000);
            } catch (error) {
                this.log(`Failed to clone emoji ${emoji.name}: ${error.message}`);
                this.stats.failed++;
            }
        }
    }

    async cloneServerInfo(sourceGuild, targetGuild) {
        this.log('🏠 Updating server info...');
        try {
            await withRetry(() => targetGuild.setName(sourceGuild.name), this.log);
            if (sourceGuild.iconURL()) {
                const icon = await downloadImage(sourceGuild.iconURL({ format: 'png', size: 1024 }));
                await withRetry(() => targetGuild.setIcon(icon), this.log);
            }
            this.log('Server info updated.');
            await delay(2000);
        } catch (e) {
            this.log(`Failed to update info: ${e.message}`);
        }
    }

    mapPermissionOverwrites(overwrites, targetGuild) {
        if (!overwrites || !overwrites.cache) return [];
        const mapped = [];
        overwrites.cache.forEach(ow => {
            try {
                let targetId = ow.id;
                if (ow.type === 'role') {
                    const mappedId = this.roleMapping.get(ow.id);
                    if (mappedId) targetId = mappedId;
                    else {
                        const targetRole = targetGuild.roles.cache.find(r => r.name === (ow.channel.guild.roles.cache.get(ow.id)?.name));
                        if (targetRole) targetId = targetRole.id;
                        else return;
                    }
                }
                mapped.push({ id: targetId, type: ow.type, allow: ow.allow, deny: ow.deny });
            } catch (e) { }
        });
        return mapped;
    }
}

module.exports = ServerCloner;
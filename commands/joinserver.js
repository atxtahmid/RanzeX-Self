const { fetch } = require('undici');

function extractInviteCode(input) {
    if (!input) return null;
    input = input.trim();

    const patterns = [
        /discord\.gg\/([a-zA-Z0-9-]+)/i,
        /discord\.com\/invite\/([a-zA-Z0-9-]+)/i,
        /discordapp\.com\/invite\/([a-zA-Z0-9-]+)/i,
        /^([a-zA-Z0-9-]+)$/
    ];

    for (const p of patterns) {
        const m = input.match(p);
        if (m && m[1]) return m[1];
    }
    return null;
}

function buildHeaders(client, code) {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';
    return {
        'Authorization': client.token,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': ua,
        'X-Discord-Locale': 'en-US',
        'X-Discord-Timezone': 'UTC',
        'Origin': 'https://discord.com',
        'Referer': `https://discord.com/invite/${code}`
    };
}

async function previewInvite(client, code) {
    const res = await fetch(`https://discord.com/api/v9/invites/${code}?with_counts=true&with_expiration=true`, {
        method: 'GET',
        headers: buildHeaders(client, code)
    });
    const data = await res.json();
    return { status: res.status, data };
}

async function joinInvite(client, code) {
    const res = await fetch(`https://discord.com/api/v9/invites/${code}`, {
        method: 'POST',
        headers: buildHeaders(client, code),
        body: JSON.stringify({})
    });
    const data = await res.json();
    return { status: res.status, data };
}

module.exports = {
    name: 'joinserver',
    aliases: ['joinsrv', 'join_guild', 'acceptinvite'],
    category: 'Utility',
    description: 'Join a Discord server via invite link',
    usage: 'joinserver <invite_link_or_code>',
    extractInviteCode,
    previewInvite,
    joinInvite,
    async execute(message, args, client) {
        if (!args.length) {
            return message.channel.send('```Usage: !joinserver <invite link or code>\nExample: !joinserver discord.gg/abc123```');
        }

        const code = extractInviteCode(args[0]);
        if (!code) {
            return message.channel.send('```❌ Invalid invite link or code.```');
        }

        try {
            const preview = await previewInvite(client, code);

            if (preview.status === 404) {
                return message.channel.send('```❌ Invalid or expired invite.```');
            }
            if (preview.status === 429) {
                const retry = preview.data.retry_after || 5;
                return message.channel.send(`\`\`\`⏳ Rate limited. Try again in ${Math.ceil(retry)}s.\`\`\``);
            }
            if (preview.status !== 200) {
                return message.channel.send(`\`\`\`❌ Preview failed: ${preview.data.message || preview.status}\`\`\``);
            }

            const guild = preview.data.guild;
            const guildName = guild?.name || 'Unknown';
            const guildId = guild?.id || 'N/A';
            const memberCount = preview.data.approximate_member_count || '?';
            const onlineCount = preview.data.approximate_presence_count || '?';

            const confirmMsg = await message.channel.send(
                `📨 **Invite Preview**\n` +
                `**Server:** ${guildName}\n` +
                `**ID:** ${guildId}\n` +
                `**Members:** ${memberCount} (${onlineCount} online)\n\n` +
                `Joining in 3 seconds... Reply \`cancel\` to abort.`
            );

            const filter = m => m.author.id === client.user.id && m.content.toLowerCase() === 'cancel';
            const collector = message.channel.createMessageCollector({ filter, time: 3000, max: 1 });
            let cancelled = false;

            collector.on('collect', () => { cancelled = true; });

            await new Promise(r => setTimeout(r, 3100));

            if (cancelled) {
                return confirmMsg.edit('❌ Join cancelled.');
            }

            const result = await joinInvite(client, code);

            if (result.status === 200) {
                return confirmMsg.edit(`✅ Successfully joined **${result.data.guild?.name || guildName}**`);
            }

            if (result.status === 429) {
                const retry = result.data.retry_after || 5;
                return confirmMsg.edit(`⏳ Rate limited. Try again in ${Math.ceil(retry)}s.`);
            }

            if (result.status === 400) {
                const msg = result.data.message || '';
                if (msg.includes('already')) return confirmMsg.edit('ℹ️ You are already a member of this server.');
                if (msg.includes('banned')) return confirmMsg.edit('🚫 You are banned from this server.');
                if (msg.includes('Maximum number')) return confirmMsg.edit('📛 Server limit reached (200 servers max).');
                return confirmMsg.edit(`❌ ${msg || 'Failed to join.'}`);
            }

            return confirmMsg.edit(`❌ Failed to join (status ${result.status}).`);
        } catch (e) {
            message.channel.send(`\`\`\`❌ Error: ${e.message}\`\`\``);
        }
    }
};
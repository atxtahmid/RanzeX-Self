module.exports = {
    name: 'purge',
    category: 'Utility',
    description: 'Delete your own messages',
    async execute(message, args, client) {
        const count = parseInt(args[0]);
        if (!count || isNaN(count)) return;

        try {
            await message.delete().catch(() => { });

            const fetched = await message.channel.messages.fetch({ limit: 100 });
            const ownMessages = fetched.filter(m => m.author.id === client.user.id && m.id !== message.id).first(count);

            const messagesToDelete = Array.isArray(ownMessages) ? ownMessages : [ownMessages];

            for (const msg of ownMessages) {
                if (!msg) continue;
                await msg.delete().catch(() => { });
                await new Promise(r => setTimeout(r, 800));
            }

            const ok = await message.channel.send("ok");
            setTimeout(() => {
                ok.delete().catch(() => { });
            }, 3000);

        } catch (e) {
        }
    }
};
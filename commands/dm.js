module.exports = {
    name: 'dm',
    category: 'Utility',
    description: 'DM a user',
    async execute(message, args, client) {
        if (args.length < 2) return;

        const userId = args[0];
        const content = args.slice(1).join(' ');

        try {
            const user = await client.users.fetch(userId).catch(() => null);
            if (!user) return;

            await user.send(content);

            const ok = await message.channel.send("ok");
            setTimeout(() => {
                ok.delete().catch(() => { });
            }, 3000);

        } catch (e) {
        }
    }
};
module.exports = {
    name: 'loop',
    aliases: ['l', 'repeat'],
    category: 'Music',
    description: 'Toggle loop state (none -> track -> queue -> none)',
    usage: 'loop [track|queue|none]',
    async execute(message, args, client) {
        if (!message.guild) return;

        const queue = client.queueManager.get(message.guild.id);
        if (!queue) {
            return message.channel.send('bro no music playing!');
        }

        const validArgs = ['none', 'track', 'queue', 'off'];
        let newState = queue.loop;

        if (args[0] && validArgs.includes(args[0].toLowerCase())) {
            const arg = args[0].toLowerCase();
            newState = arg === 'off' ? 'none' : arg;
        } else {
            if (queue.loop === 'none') newState = 'track';
            else if (queue.loop === 'track') newState = 'queue';
            else if (queue.loop === 'queue') newState = 'none';
        }

        queue.loop = newState;

        let icon = '▶️';
        if (newState === 'track') icon = '🔂';
        if (newState === 'queue') icon = '🔁';

        let response = '```js\n';
        response += ` ${icon} Loop mode set to: ${newState.toUpperCase()}\n`;
        response += '╰──────────────────────────────────╯\n```';

        await message.channel.send(response);
    }
};
const { MessageAttachment } = require('discord.js-selfbot-v13');
const { generateImageWithFallback } = require('./imageFallbackManager');

module.exports = {
    name: 'img',
    description: 'Generate an AI image based on prompt',
    async execute(message, args, client) {
        if (!args.length) {
            return message.reply({ content: 'Please provide a prompt! Example: `!img a futuristic city at sunset`' });
        }

        const prompt = args.join(' ');

        let waitMsg;
        try {
            await new Promise(resolve => setTimeout(resolve, 1000));
            waitMsg = await message.channel.send('ok ok');
        } catch (e) {
            console.error('Failed to send wait message:', e);
        }

        try {
            const buffer = await generateImageWithFallback(prompt, console.log);

            const attachment = new MessageAttachment(buffer, 'generated.png');

            await message.channel.send({
                files: [attachment]
            });

            if (waitMsg) {
                try {
                    await waitMsg.delete();
                } catch (e) {}
            }

        } catch (error) {
            console.error('AI Image Generation Error:', error);
            if (waitMsg) {
                try {
                    await waitMsg.edit({ content: `❌ Failed to generate image: All providers failed.` });
                } catch (e) {
                    await message.channel.send({ content: `❌ Failed to generate image.` });
                }
            }
        }
    }
};
const fetch = require('node-fetch');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function toBuffer(source) {
    if (source.startsWith('http')) {
        const res = await fetch(source);
        return await res.buffer();
    }
    const base64Data = source.split(',')[1];
    return Buffer.from(base64Data, 'base64');
}

async function generatePollinations(prompt) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=576&nologo=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Pollinations failed: ${res.status}`);
    return await res.buffer();
}

async function generateGimmy(prompt) {
    if (!process.env.GIMMY_API_KEY) throw new Error('Gimmy key missing');
    const url = 'https://gimmy-lab.hf.space/generate';
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.GIMMY_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt })
    });
    if (!res.ok) throw new Error(`Gimmy failed: ${res.status}`);
    const data = await res.json();
    return await toBuffer(data.url || data.image);
}

async function generateFreeTheAI(prompt) {
    if (!process.env.FREETHEAI_API_KEY) throw new Error('FreeTheAI key missing');
    const url = 'https://api.freetheai.xyz/v1/images/generations';
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.FREETHEAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'eve/gpt-image-2',
            prompt: prompt,
            n: 1,
            size: '1024x576'
        })
    });
    if (!res.ok) throw new Error(`FreeTheAI failed: ${res.status}`);
    const data = await res.json();
    return await toBuffer(data.data[0].url || data.data[0].b64_json);
}

async function generateCloudflare(prompt) {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!token || !accountId) throw new Error('Cloudflare keys missing');

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt })
    });
    if (!res.ok) throw new Error(`Cloudflare failed: ${res.status}`);
    const data = await res.json();
    return Buffer.from(data.result.image, 'base64');
}

async function generateTogether(prompt) {
    if (!process.env.TOGETHER_API_KEY) throw new Error('Together key missing');
    const url = 'https://api.together.xyz/v1/images/generations';
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.TOGETHER_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'black-forest-labs/FLUX.1-schnell-Free',
            prompt: prompt,
            width: 1024,
            height: 576,
            steps: 4,
            n: 1
        })
    });
    if (!res.ok) throw new Error(`Together failed: ${res.status}`);
    const data = await res.json();
    return await toBuffer(data.data[0].url);
}

async function generateHuggingFace(prompt) {
    if (!process.env.HUGGINGFACE_API_KEY) throw new Error('HuggingFace key missing');
    const url = 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-2-1';
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ inputs: prompt })
    });
    if (!res.ok) throw new Error(`HuggingFace failed: ${res.status}`);
    return await res.buffer();
}

async function generateReplicate(prompt) {
    if (!process.env.REPLICATE_API_KEY) throw new Error('Replicate key missing');
    const url = 'https://api.replicate.com/v1/predictions';
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.REPLICATE_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            version: 'black-forest-labs/flux-schnell',
            input: { prompt: prompt }
        })
    });
    if (!res.ok) throw new Error(`Replicate failed: ${res.status}`);
    const prediction = await res.json();
    let result = prediction;
    while (result.status !== 'succeeded' && result.status !== 'failed') {
        await delay(2000);
        const pollRes = await fetch(result.urls.get, {
            headers: { 'Authorization': `Bearer ${process.env.REPLICATE_API_KEY}` }
        });
        result = await pollRes.json();
    }
    if (result.status === 'failed') throw new Error('Replicate prediction failed');
    return await toBuffer(result.output[0]);
}

const providers = [
    { name: 'Pollinations', fn: generatePollinations },
    { name: 'Gimmy Lab', fn: generateGimmy },
    { name: 'Free The AI', fn: generateFreeTheAI },
    { name: 'Cloudflare', fn: generateCloudflare },
    { name: 'Together', fn: generateTogether },
    { name: 'HuggingFace', fn: generateHuggingFace },
    { name: 'Replicate', fn: generateReplicate },
];

async function generateImageWithFallback(prompt, log = console.log) {
    for (const provider of providers) {
        try {
            log(`[Image Fallback] Trying ${provider.name}...`);
            const buffer = await provider.fn(prompt);
            if (buffer && buffer.length > 0) {
                log(`[Image Fallback] Success with ${provider.name}.`);
                return buffer;
            }
            throw new Error('Empty buffer returned');
        } catch (error) {
            log(`[Image Fallback] ${provider.name} failed: ${error.message}`);
            await delay(1000);
        }
    }
    throw new Error('All image providers failed.');
}

module.exports = { generateImageWithFallback };
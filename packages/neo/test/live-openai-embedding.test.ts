import { liveEmbeddingSuite } from './live-embedding-suite.ts';

// The cheapest current embedding model. This vendor takes a batch of up to
// 2048 inputs and reports what the request cost in tokens, so it exercises
// every option the suite has.
liveEmbeddingSuite({
    label: 'openai',
    ref: { provider: 'openai', model: 'text-embedding-3-small' },
    enabled: Boolean(process.env.OPENAI_API_KEY),
    truncatedWidth: 256,
});

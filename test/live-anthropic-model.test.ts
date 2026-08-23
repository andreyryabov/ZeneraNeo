import { liveModelSuite } from './live-model-suite.ts';

// Extended thinking stays off (the adapter's default): it does not survive a
// multi-turn tool round trip, which is exactly what this suite does.
liveModelSuite({
    label: 'anthropic',
    ref: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 1024,
    },
    enabled: Boolean(process.env.ANTHROPIC_API_KEY),
});

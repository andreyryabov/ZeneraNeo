import { liveModelSuite } from './live-model-suite.ts';

// The cheapest current reasoning model, on the Responses API (the default for
// this vendor in the runtime) with reasoning turned down: this suite is about
// wire-format conformance, not about thinking.
liveModelSuite({
    label: 'openai',
    ref: {
        provider: 'openai',
        api: 'responses',
        model: 'gpt-5.4-nano',
        reasoningEffort: 'low',
    },
    enabled: Boolean(process.env.OPENAI_API_KEY),
});

import { liveModelSuite } from './live-model-suite.ts';

// The one adapter whose responses are *validated* on the way in: the SDK parses
// every field against a zod schema, so an upstream provider returning a shape
// it does not expect raises `ResponseValidationError` rather than being passed
// through. Nothing offline can catch that, which makes this suite the only
// place the risk of adopting the SDK actually shows up.
//
// A free model on purpose: the suite runs a full tool round trip and there is
// no reason for a conformance check to cost anything.
liveModelSuite({
    label: 'openrouter',
    ref: {
        provider: 'openrouter',
        model: 'inclusionai/ling-3.0-flash-fin:free',
    },
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
});

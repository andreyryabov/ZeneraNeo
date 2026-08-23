import { liveModelSuite } from './live-model-suite.ts';

// Vertex rather than the Gemini API, because the credentials here are a
// service-account key and the GenAI SDK resolves those itself as Application
// Default Credentials — so there is no api key to gate on.
//
// The gate is the project instead: it is what `createModel` requires up front,
// and it can be named directly, or come from a key file. Credentials proper are
// resolved later, on the first request, by any of three routes — so a project
// with nothing usable behind it should fail the suite, not skip it.
liveModelSuite({
    label: 'gemini',
    ref: {
        provider: 'vertex',
        model: 'gemini-3.5-flash-lite',
        thinkingLevel: 'minimal',
        maxTokens: 1024,
    },
    enabled: Boolean(
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        process.env.VERTEX_API_KEY,
    ),
});

import { liveEmbeddingSuite } from './live-embedding-suite.ts';

// Vertex rather than the Gemini API, for the reason `live-gemini-model.test.ts`
// gives: the credentials here are a service-account key, which the GenAI SDK
// resolves itself as Application Default Credentials, so there is no api key to
// gate on.
//
// `reportsUsage` is off because this API counts billable *characters* rather
// than tokens, and only on Vertex — which is not a token count, so the adapter
// reports no usage at all rather than putting a different number in the same
// field.
liveEmbeddingSuite({
    label: 'gemini',
    ref: { provider: 'vertex', model: 'gemini-embedding-2' },
    enabled: Boolean(
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        process.env.VERTEX_API_KEY,
    ),
    reportsUsage: false,
    truncatedWidth: 768,
});

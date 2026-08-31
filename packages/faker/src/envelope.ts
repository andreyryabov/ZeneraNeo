// ---------------------------------------------------------------------------
// What a generator is handed
//
// One shape, written by the server for a real request and by the build loop for
// a synthetic probe. That they are the same shape is the whole reason a
// generator that satisfies its probes also satisfies traffic.
// ---------------------------------------------------------------------------

export interface GeneratorInput {
    operationId: string;
    method: string;
    /** the template, not the resolved path — `/users/{user_id}` */
    path: string;
    pathParams: Record<string, unknown>;
    query: Record<string, unknown>;
    headers: Record<string, string>;
    body: unknown;
    /** seeds `random` and `Faker` inside the generator */
    seed: number;
}

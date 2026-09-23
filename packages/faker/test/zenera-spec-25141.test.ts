import { describe, it } from 'vitest';
import { loadSpec } from '../src/spec.ts';

describe('one-off spec dump', () => {
    it('prints operation metadata', async () => {
        const files = [
            'packages/faker/test/specs/petstore.yaml',
            'packages/faker/test/specs/paged.yaml',
        ];
        for (const file of files) {
            const spec: any = await loadSpec(file);
            const operations: any[] = [];
            const seen = new Set<object>();
            const walk = (value: any) => {
                if (!value || typeof value !== 'object' || seen.has(value)) return;
                seen.add(value);
                if (Array.isArray(value)) return value.forEach(walk);
                if (typeof value.operationId === 'string')
                    operations.push({
                        operationId: value.operationId,
                        key: value.key,
                        params: value.params,
                        paging: value.paging,
                    });
                Object.values(value).forEach(walk);
            };
            walk(spec);
            console.log(JSON.stringify({ file, operations }, null, 2));
        }
    });
});

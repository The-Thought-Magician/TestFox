import * as assert from 'assert';
import {
    fetchWithTimeout,
    FetchTimeoutError,
    isFetchTimeoutError,
    resolveTimeoutMs,
    DEFAULT_PROBE_TIMEOUT_MS,
    DEFAULT_GENERATION_TIMEOUT_MS
} from '../../utils/fetchWithTimeout';

suite('fetchWithTimeout', () => {

    test('resolves with the response when the server answers in time', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
        try {
            const res = await fetchWithTimeout('https://api.example.com/models', { timeoutMs: 1000 });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(await res.text(), 'ok');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('aborts a hanging request with FetchTimeoutError after timeoutMs', async function() {
        this.timeout(10000);
        const originalFetch = globalThis.fetch;
        // Simulates the pre-fix behavior: a request that never resolves on its own.
        globalThis.fetch = ((url: any, init?: any) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
        })) as typeof fetch;
        try {
            const start = Date.now();
            await assert.rejects(
                fetchWithTimeout('https://api.example.com/chat/completions', { timeoutMs: 100 }),
                (err: unknown) => {
                    assert.ok(isFetchTimeoutError(err), `expected FetchTimeoutError, got ${err}`);
                    return true;
                }
            );
            const elapsed = Date.now() - start;
            assert.ok(elapsed < 5000, `request took too long to fail: ${elapsed}ms`);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('timeout error message names the host without leaking query-string secrets', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((url: any, init?: any) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
        })) as typeof fetch;
        try {
            await assert.rejects(
                fetchWithTimeout('https://generativelanguage.example.com/v1/models/x:generate?key=SECRET123', { timeoutMs: 50 }),
                (err: unknown) => {
                    assert.ok(err instanceof FetchTimeoutError);
                    assert.ok(err.message.includes('generativelanguage.example.com'), 'message should name the host');
                    assert.ok(!err.message.includes('SECRET123'), 'message must not leak query-string secrets');
                    return true;
                }
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('caller cancellation is not reported as a timeout', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((url: any, init?: any) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
        })) as typeof fetch;
        const caller = new AbortController();
        setTimeout(() => caller.abort(new Error('user cancelled')), 20);
        try {
            await assert.rejects(
                fetchWithTimeout('https://api.example.com/chat', { timeoutMs: 60000, signal: caller.signal }),
                (err: unknown) => {
                    assert.ok(!isFetchTimeoutError(err), 'caller abort must not become a FetchTimeoutError');
                    return true;
                }
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('resolveTimeoutMs falls back on missing or invalid settings', () => {
        assert.strictEqual(resolveTimeoutMs(undefined), DEFAULT_GENERATION_TIMEOUT_MS);
        assert.strictEqual(resolveTimeoutMs(NaN), DEFAULT_GENERATION_TIMEOUT_MS);
        assert.strictEqual(resolveTimeoutMs(0), DEFAULT_GENERATION_TIMEOUT_MS);
        assert.strictEqual(resolveTimeoutMs(-5), DEFAULT_GENERATION_TIMEOUT_MS);
        assert.strictEqual(resolveTimeoutMs(500), DEFAULT_GENERATION_TIMEOUT_MS, 'sub-second values are rejected');
        assert.strictEqual(resolveTimeoutMs(45000), 45000);
        assert.strictEqual(resolveTimeoutMs('30000'), 30000);
        assert.strictEqual(DEFAULT_PROBE_TIMEOUT_MS, 15000);
    });

    test('rule-based fallback contract: a timed-out AI request rejects (so callers fall back) instead of hanging', async function() {
        this.timeout(10000);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((url: any, init?: any) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
        })) as typeof fetch;
        try {
            // Mirrors the fallback path in openRouterClient.generate() and
            // testGeneratorAI: on any request failure the caller must get a
            // rejection it can catch, then produce rule-based tests.
            let fallbackUsed = false;
            const generateWithFallback = async (): Promise<string> => {
                try {
                    await fetchWithTimeout('https://api.example.com/chat/completions', { timeoutMs: 75 });
                    return 'ai-result';
                } catch (error) {
                    assert.ok(isFetchTimeoutError(error));
                    fallbackUsed = true;
                    return 'rule-based-result';
                }
            };
            const result = await generateWithFallback();
            assert.strictEqual(result, 'rule-based-result');
            assert.ok(fallbackUsed);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

/**
 * Shared fetch wrapper with a real timeout and cancellation support.
 *
 * Native `fetch` silently ignores the `timeout` option that some callers
 * pass in the request init, which meant AI requests could hang forever
 * (see https://github.com/senthazalravi/TestFox/issues/20).
 *
 * This module is intentionally free of any `vscode` import so it can be
 * unit tested in plain Node and reused by every AI provider client.
 */

/** Default timeout for lightweight calls (model lists, availability checks). */
export const DEFAULT_PROBE_TIMEOUT_MS = 15000;

/** Default timeout for AI generation calls (chat completions). */
export const DEFAULT_GENERATION_TIMEOUT_MS = 120000;

/**
 * Error thrown when a request exceeds its timeout. Distinct from an
 * abort requested by the caller, which rethrows the original abort error.
 */
export class FetchTimeoutError extends Error {
    public readonly url: string;
    public readonly timeoutMs: number;

    constructor(url: string, timeoutMs: number) {
        super(
            `Request to ${redactUrl(url)} timed out after ${timeoutMs}ms. ` +
            `Check your network connection or VPN, or increase the ` +
            `"testfox.ai.requestTimeout" setting if the model legitimately needs longer.`
        );
        this.name = 'FetchTimeoutError';
        this.url = url;
        this.timeoutMs = timeoutMs;
        // Restore the prototype chain for ES5-transpiled consumers.
        Object.setPrototypeOf(this, FetchTimeoutError.prototype);
    }
}

/** Type guard that also matches cross-realm FetchTimeoutError instances. */
export function isFetchTimeoutError(error: unknown): error is FetchTimeoutError {
    return error instanceof FetchTimeoutError ||
        (typeof error === 'object' && error !== null && (error as { name?: string }).name === 'FetchTimeoutError');
}

/** Drop query strings (which may carry API keys, e.g. Gemini's ?key=) from URLs in error messages. */
function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url;
    }
}

export interface FetchWithTimeoutOptions extends RequestInit {
    /** Milliseconds before the request is aborted with a FetchTimeoutError. */
    timeoutMs?: number;
}

/**
 * `fetch` with an enforced timeout.
 *
 * - Aborts with {@link FetchTimeoutError} after `timeoutMs`.
 * - If the caller's own `signal` fires, the original abort propagates
 *   (this is a caller cancellation, not a timeout).
 * - The timer is always cleared, so a finished request never holds the
 *   event loop open.
 */
export async function fetchWithTimeout(url: string, options: FetchWithTimeoutOptions = {}): Promise<Response> {
    const { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, signal: callerSignal, ...init } = options;

    const controller = new AbortController();
    let onCallerAbort: (() => void) | undefined;
    if (callerSignal) {
        if (callerSignal.aborted) {
            controller.abort(callerSignal.reason);
        } else {
            onCallerAbort = () => controller.abort(callerSignal.reason);
            callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        }
    }

    const timer = setTimeout(() => controller.abort(new FetchTimeoutError(url, timeoutMs)), timeoutMs);

    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
        if (callerSignal?.aborted) {
            // Caller-initiated cancellation: not a timeout.
            throw error;
        }
        if (controller.signal.aborted) {
            const reason = controller.signal.reason;
            if (isFetchTimeoutError(reason)) {
                throw reason;
            }
            throw new FetchTimeoutError(url, timeoutMs);
        }
        throw error;
    } finally {
        clearTimeout(timer);
        if (callerSignal && onCallerAbort) {
            callerSignal.removeEventListener('abort', onCallerAbort);
        }
    }
}

/**
 * Resolve a configured timeout (from settings) into a sane millisecond
 * value, falling back when the setting is missing or invalid.
 */
export function resolveTimeoutMs(configured: unknown, fallback: number = DEFAULT_GENERATION_TIMEOUT_MS): number {
    const value = typeof configured === 'number' ? configured : Number(configured);
    if (Number.isFinite(value) && value >= 1000) {
        return Math.floor(value);
    }
    return fallback;
}

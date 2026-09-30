import * as vscode from 'vscode';

/**
 * Secure storage for AI provider API keys.
 *
 * Historically TestFox wrote API keys to the global `testfox.ai.apiKey`
 * setting in plaintext (settings sync included). This module moves the key
 * into VS Code's SecretStorage, migrates any legacy plaintext value on first
 * read, and erases the legacy setting afterwards.
 *
 * It also implements "local-only mode" (`testfox.ai.localOnly`): when
 * enabled, only providers that run on the user's own machine (Ollama,
 * LM Studio) may be used, so no prompts or keys ever leave the device.
 */

const API_KEY_SECRET = 'testfox.ai.apiKey';
const LEGACY_API_KEY_SETTING = 'ai.apiKey';

let extensionContext: vscode.ExtensionContext | undefined;
let cachedApiKey: string | undefined;

/**
 * Last known API key, kept in memory for synchronous UI checks
 * (status bars, onboarding hints). Prime it during activation with
 * `getApiKey()`; prefer the async accessors whenever possible.
 */
export function getCachedApiKey(): string {
    return cachedApiKey ?? '';
}

/** Call once from `activate()` so every module can reach SecretStorage. */
export function initializeSecureKeyStore(context: vscode.ExtensionContext): void {
    extensionContext = context;
}

function getSecrets(): vscode.SecretStorage | undefined {
    return extensionContext?.secrets;
}

async function clearLegacySetting(): Promise<void> {
    await vscode.workspace
        .getConfiguration('testfox')
        .update(LEGACY_API_KEY_SETTING, undefined, vscode.ConfigurationTarget.Global);
}

/**
 * One-time migration: move a plaintext key stored in settings into
 * SecretStorage and remove it from settings. Returns true when a key moved.
 */
export async function migrateApiKeyToSecrets(context?: vscode.ExtensionContext): Promise<boolean> {
    if (context) {
        initializeSecureKeyStore(context);
    }
    const secrets = getSecrets();
    if (!secrets) {
        return false;
    }
    const config = vscode.workspace.getConfiguration('testfox');
    const legacy = config.get<string>(LEGACY_API_KEY_SETTING);
    if (!legacy) {
        return false;
    }
    await secrets.store(API_KEY_SECRET, legacy);
    await config.update(LEGACY_API_KEY_SETTING, undefined, vscode.ConfigurationTarget.Global);
    console.log('TestFox: Migrated AI API key from settings to secure storage');
    return true;
}

/**
 * Read the configured AI API key. Prefers SecretStorage; a legacy
 * plaintext setting is migrated on first read and then erased.
 */
export async function getApiKey(): Promise<string> {
    const secrets = getSecrets();
    if (secrets) {
        const stored = await secrets.get(API_KEY_SECRET);
        if (stored) {
            cachedApiKey = stored;
            return stored;
        }
    }
    const legacy = vscode.workspace.getConfiguration('testfox').get<string>(LEGACY_API_KEY_SETTING);
    if (legacy) {
        await migrateApiKeyToSecrets();
        cachedApiKey = legacy;
        return legacy;
    }
    cachedApiKey = '';
    return '';
}

export async function hasApiKey(): Promise<boolean> {
    return (await getApiKey()).length > 0;
}

/** Store (or, when empty, remove) the AI API key in SecretStorage. */
export async function setApiKey(apiKey: string): Promise<void> {
    const secrets = getSecrets();
    if (!secrets) {
        // Extension host not initialized yet: keep previous behavior.
        await vscode.workspace
            .getConfiguration('testfox')
            .update(LEGACY_API_KEY_SETTING, apiKey, vscode.ConfigurationTarget.Global);
        return;
    }
    if (apiKey) {
        await secrets.store(API_KEY_SECRET, apiKey);
    } else {
        await secrets.delete(API_KEY_SECRET);
    }
    cachedApiKey = apiKey;
    // Never leave a plaintext copy behind.
    await clearLegacySetting();
}

export async function clearApiKey(): Promise<void> {
    await getSecrets()?.delete(API_KEY_SECRET);
    cachedApiKey = '';
    await clearLegacySetting();
}

/** True when the user enabled local-only AI mode. */
export function isLocalOnlyMode(): boolean {
    return vscode.workspace.getConfiguration('testfox').get<boolean>('ai.localOnly', false);
}

const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'local']);

/** Providers that run entirely on the user's machine (no cloud calls). */
export function isLocalProvider(provider: string | undefined): boolean {
    return !!provider && LOCAL_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Returns a user-facing error message when local-only mode blocks the
 * given provider, or undefined when the provider is allowed.
 */
export function localOnlyViolation(provider: string | undefined): string | undefined {
    if (isLocalOnlyMode() && !isLocalProvider(provider)) {
        return (
            `TestFox local-only mode is enabled (testfox.ai.localOnly): the cloud AI provider ` +
            `"${provider || 'unknown'}" is disabled. Use Ollama or LM Studio, or turn local-only mode off.`
        );
    }
    return undefined;
}

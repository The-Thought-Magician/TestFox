import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    initializeSecureKeyStore,
    migrateApiKeyToSecrets,
    getApiKey,
    setApiKey,
    clearApiKey,
    getCachedApiKey,
    isLocalProvider,
    isLocalOnlyMode,
    localOnlyViolation
} from '../../core/secureKeyStore';

class FakeSecretStorage implements vscode.SecretStorage {
    private map = new Map<string, string>();
    keys(): Thenable<string[]> { return Promise.resolve([...this.map.keys()]); }
    get(key: string): Thenable<string | undefined> { return Promise.resolve(this.map.get(key)); }
    store(key: string, value: string): Thenable<void> { this.map.set(key, value); return Promise.resolve(); }
    delete(key: string): Thenable<void> { this.map.delete(key); return Promise.resolve(); }
    onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event;
}

function fakeContext(secrets: FakeSecretStorage): vscode.ExtensionContext {
    return { secrets } as unknown as vscode.ExtensionContext;
}

async function clearLegacySetting(): Promise<void> {
    await vscode.workspace.getConfiguration('testfox')
        .update('ai.apiKey', undefined, vscode.ConfigurationTarget.Global);
}

suite('secureKeyStore', () => {
    let secrets: FakeSecretStorage;

    setup(async () => {
        secrets = new FakeSecretStorage();
        initializeSecureKeyStore(fakeContext(secrets));
        await clearLegacySetting();
    });

    teardown(async () => {
        await clearLegacySetting();
        await vscode.workspace.getConfiguration('testfox')
            .update('ai.localOnly', undefined, vscode.ConfigurationTarget.Global);
    });

    test('migrates a plaintext key from settings into SecretStorage and erases it', async () => {
        await vscode.workspace.getConfiguration('testfox')
            .update('ai.apiKey', 'sk-legacy-123', vscode.ConfigurationTarget.Global);

        const migrated = await migrateApiKeyToSecrets();

        assert.strictEqual(migrated, true);
        assert.strictEqual(await secrets.get('testfox.ai.apiKey'), 'sk-legacy-123');
        assert.strictEqual(
            vscode.workspace.getConfiguration('testfox').inspect<string>('ai.apiKey')?.globalValue,
            undefined,
            'legacy plaintext setting must be removed after migration'
        );
    });

    test('getApiKey prefers SecretStorage and auto-migrates legacy values', async () => {
        await secrets.store('testfox.ai.apiKey', 'sk-secure');
        assert.strictEqual(await getApiKey(), 'sk-secure');

        const other = new FakeSecretStorage();
        initializeSecureKeyStore(fakeContext(other));
        await vscode.workspace.getConfiguration('testfox')
            .update('ai.apiKey', 'sk-legacy-456', vscode.ConfigurationTarget.Global);
        assert.strictEqual(await getApiKey(), 'sk-legacy-456');
        assert.strictEqual(await other.get('testfox.ai.apiKey'), 'sk-legacy-456');
    });

    test('setApiKey stores in secrets, updates the cache and never writes settings', async () => {
        await setApiKey('sk-new');
        assert.strictEqual(await secrets.get('testfox.ai.apiKey'), 'sk-new');
        assert.strictEqual(getCachedApiKey(), 'sk-new');
        assert.strictEqual(
            vscode.workspace.getConfiguration('testfox').inspect<string>('ai.apiKey')?.globalValue,
            undefined
        );

        await clearApiKey();
        assert.strictEqual(await secrets.get('testfox.ai.apiKey'), undefined);
        assert.strictEqual(getCachedApiKey(), '');
    });

    test('local-only mode blocks cloud providers but allows Ollama and LM Studio', async () => {
        assert.strictEqual(isLocalProvider('ollama'), true);
        assert.strictEqual(isLocalProvider('lmstudio'), true);
        assert.strictEqual(isLocalProvider('openrouter'), false);

        assert.strictEqual(isLocalOnlyMode(), false);
        assert.strictEqual(localOnlyViolation('openrouter'), undefined);

        await vscode.workspace.getConfiguration('testfox')
            .update('ai.localOnly', true, vscode.ConfigurationTarget.Global);

        assert.strictEqual(isLocalOnlyMode(), true);
        assert.ok(localOnlyViolation('openrouter')?.includes('local-only'));
        assert.strictEqual(localOnlyViolation('ollama'), undefined);
    });
});

import { autoInstall } from './completion-install.ts';

try {
    autoInstall();
} catch (error) {
    // Optional shell setup must not prevent installing the CLI.
    console.error(
        `zen: automatic completion setup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error('zen: run zen completion --install to retry.');
}

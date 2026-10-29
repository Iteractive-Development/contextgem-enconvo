import { CredentialsProvider } from "@enconvo/api";

/**
 * An API-key credential managed through Enconvo's standard credential management:
 * encrypted at rest, masked in the UI, picked by commands and read by routes.
 *
 * ContextGem sends the key to whichever model provider the user configured, so there is
 * no single endpoint to verify it against when it is saved. The check here covers what
 * can be known up front (a non-empty, single-token value); the provider itself rejects a
 * wrong key at the first extraction, and that error comes back with the key redacted.
 */
export class ApiKeyCredentials extends CredentialsProvider {
    private readonly label: string;

    constructor(options: CredentialsProvider.AuthOptions, label: string) {
        super(options);
        this.label = label;
    }

    async _validate(): Promise<CredentialsProvider.ValidateResult> {
        const key = String(this.options.apiKey ?? "");
        if (!key.trim()) return { valid: false, message: `No ${this.label} API key set.` };
        if (/\s/.test(key.trim())) {
            return { valid: false, message: `The ${this.label} API key contains whitespace; paste only the key itself.` };
        }
        return {
            valid: true,
            message: `${this.label} API key saved. It is sent to the provider of the model you configure and checked on the first extraction.`,
        };
    }

    /** API-key credential: no OAuth flow. */
    async _authenticate(): Promise<CredentialsProvider.Credentials | null> {
        return null;
    }

    async _load(): Promise<CredentialsProvider.Credentials | null> {
        return null;
    }
}

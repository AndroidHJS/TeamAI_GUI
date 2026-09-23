import type { SshCredentialState } from "../src/types";
import type { SshEndpoint } from "./validation";

export interface CredentialSettings {
  sshCredentials: Record<string, string>;
  workspaceCredentialBindings: Record<string, string>;
}

export interface CredentialBackingStore {
  get<Key extends keyof CredentialSettings>(key: Key): CredentialSettings[Key];
  set<Key extends keyof CredentialSettings>(key: Key, value: CredentialSettings[Key]): void;
}

export interface CredentialCryptography {
  isEncryptionAvailable(): boolean;
  encrypt(password: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export class CredentialManager {
  private readonly sessionCredentials = new Map<string, string>();

  constructor(
    private readonly store: CredentialBackingStore,
    private readonly cryptography: CredentialCryptography,
  ) {}

  state(endpoint: SshEndpoint): SshCredentialState {
    return {
      configured: this.sessionCredentials.has(endpoint.key) || this.readPersistent(endpoint.key) !== null,
      username: endpoint.username,
      host: endpoint.host,
      port: endpoint.port,
    };
  }

  resolveForInit(endpoint: SshEndpoint, supplied?: string): string | null {
    return supplied ?? this.sessionCredentials.get(endpoint.key) ?? this.readPersistent(endpoint.key);
  }

  resolveForWorkspace(workingDirectory: string): string | null {
    const key = this.store.get("workspaceCredentialBindings")[workingDirectory];
    return key ? this.sessionCredentials.get(key) ?? this.readPersistent(key) : null;
  }

  commitSuccessfulInit(endpoint: SshEndpoint, workingDirectory: string, password: string | undefined, remember: boolean): void {
    const existing = this.sessionCredentials.get(endpoint.key) ?? this.readPersistent(endpoint.key);
    if (password !== undefined) {
      if (remember) {
        if (!this.cryptography.isEncryptionAvailable()) throw new Error("当前系统安全存储不可用，无法记住 SSH 密码。");
        const credentials = { ...this.store.get("sshCredentials") };
        credentials[endpoint.key] = this.cryptography.encrypt(password).toString("base64");
        this.store.set("sshCredentials", credentials);
        this.sessionCredentials.delete(endpoint.key);
      } else {
        this.sessionCredentials.set(endpoint.key, password);
      }
    }
    if (password !== undefined || existing !== null) {
      const bindings = { ...this.store.get("workspaceCredentialBindings"), [workingDirectory]: endpoint.key };
      this.store.set("workspaceCredentialBindings", bindings);
    }
  }

  delete(endpoint: SshEndpoint): boolean {
    const credentials = { ...this.store.get("sshCredentials") };
    const hadPersistent = Object.hasOwn(credentials, endpoint.key);
    const hadSession = this.sessionCredentials.delete(endpoint.key);
    if (hadPersistent) {
      delete credentials[endpoint.key];
      this.store.set("sshCredentials", credentials);
    }
    const bindings = { ...this.store.get("workspaceCredentialBindings") };
    let removedBinding = false;
    for (const [directory, key] of Object.entries(bindings)) {
      if (key === endpoint.key) {
        delete bindings[directory];
        removedBinding = true;
      }
    }
    if (removedBinding) this.store.set("workspaceCredentialBindings", bindings);
    return hadPersistent || hadSession || removedBinding;
  }

  clearSession(): void {
    this.sessionCredentials.clear();
  }

  private readPersistent(key: string): string | null {
    const encoded = this.store.get("sshCredentials")[key];
    if (!encoded || !this.cryptography.isEncryptionAvailable()) return null;
    try {
      return this.cryptography.decrypt(Buffer.from(encoded, "base64"));
    } catch {
      return null;
    }
  }
}

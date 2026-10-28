// The TLS settings over the async storage (#313). The renewer's status, the HTTP gate that runs on every request and the issuer's
// lifetime read them synchronously, so they are loaded once and held; a write goes to storage first and the held copy changes when
// it has resolved. Writes run one at a time. This server is the only writer of these rows.
import { SERVING_DEFAULTS, type ServingSettings } from './tlsRenew.js';
import type { ReporterSettings } from './tlsReporterRenew.js';
import { REPORTER_DAYS } from './tlsPeople.js';
import { Serializer } from './fleet/serial.js';
import type { Storage, TlsSettingsApi } from './storage/types.js';

/** What `TlsSettingsStore.set` answers, with whether reporters were allowed over HTTP before it. */
type Saved = Awaited<ReturnType<TlsSettingsApi['set']>>;
export type TlsSetResult = (Extract<Saved, { ok: true }> & { wasAllowed: boolean }) | Extract<Saved, { ok: false }>;

type Held = { serving: ServingSettings; reporter: ReporterSettings; allowHttp: boolean };

export class LiveTlsSettings {
  private serving: ServingSettings = { ...SERVING_DEFAULTS };
  private reporter: ReporterSettings = { lifetimeDays: REPORTER_DAYS };
  private allowHttp = true;
  private readonly writes = new Serializer();

  constructor(
    private readonly store: TlsSettingsApi,
    private readonly tx: Storage['tx'],
  ) {}

  async load(): Promise<void> {
    this.hold(await this.tx(() => this.read()));
  }

  /** The stored values. The held copy changes only after the transaction around the read has committed, so a rollback leaves it alone. */
  private async read(): Promise<Held> {
    return { serving: await this.store.get(), reporter: await this.store.getReporter(), allowHttp: await this.store.allowReportersOverHttp() };
  }

  private hold(h: Held): void {
    this.serving = h.serving;
    this.reporter = h.reporter;
    this.allowHttp = h.allowHttp;
  }

  get(): ServingSettings {
    return { ...this.serving };
  }

  getReporter(): ReporterSettings {
    return { ...this.reporter };
  }

  /** `tls.allowReportersOverHttp`; a missing row reads as on. */
  allowReportersOverHttp(): boolean {
    return this.allowHttp;
  }

  /** The first time TLS runs: on for an install that already has reporters, off for a fresh one. A row that exists is left alone. */
  seedAllowReportersOverHttp(existingInstall: boolean): Promise<void> {
    return this.writes.run('write', async () => {
      this.allowHttp = await this.tx(async () => {
        await this.store.seedAllowReportersOverHttp(existingInstall);
        return this.store.allowReportersOverHttp();
      });
    });
  }

  /** Saves the given settings and holds what is stored. Every value is checked first and nothing is saved when one fails. */
  set(patch: Record<string, unknown>): Promise<TlsSetResult> {
    return this.writes.run('write', async () => {
      const wasAllowed = this.allowHttp;
      const { saved, held } = await this.tx(async () => {
        const saved = await this.store.set(patch);
        return { saved, held: saved.ok ? await this.read() : null };
      });
      if (held) this.hold(held);
      return saved.ok ? { ...saved, wasAllowed } : saved;
    });
  }
}

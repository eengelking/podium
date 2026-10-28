// The Admin's settings over the async storage (#313). Many readers are synchronous and cannot wait: a feature flag is checked in
// the middle of a report, a price while a card is built, the wall's settings while a snapshot is assembled. Each class here loads
// its setting once, answers reads from memory, and writes through: a write goes to storage first and the memory changes only
// when that write has resolved, then the change callback runs. Writes to one setting run one at a time, in the order they were
// asked for, so the last one to resolve is the one stored and the one held. This server is the only writer of these rows.
import { FEATURES, featureDefault, isFeatureId, isNoticeId } from '../storage/rows.js';
import { Pricing, type PriceOverrides } from './pricing.js';
import { Serializer } from './serial.js';
import { RECORDING_DEFAULTS, type ModelPricesView, type RecordingSettings, type WallSettingsView } from './protocol.js';
import { ACTIVITY_HISTORY_DEFAULTS, type ActivityHistorySettings } from './activityHistoryTypes.js';
import type { ModelPrice } from './pricing.js';
import type { ActivityHistorySettingsApi, FeatureFlagsApi, ModelPricesApi, RecordingSettingsApi, Storage, WallSettingsApi } from '../storage/types.js';

const WRITES = 'write';

/** Server-wide feature flags (see `FeatureFlags`): `featureOn` and `view` are synchronous, `setFeature` resolves once the flag is stored. */
export class LiveFeatureFlags {
  private flags: Record<string, boolean> = Object.fromEntries(FEATURES.map((f) => [f.id, f.defaultOn]));
  private readonly writes = new Serializer();

  constructor(
    private readonly store: FeatureFlagsApi,
    private readonly onChange: (id: string, on: boolean) => void = () => {},
  ) {}

  /** Reads every flag from storage. */
  async load(): Promise<void> {
    this.flags = await this.store.view();
  }

  featureOn(id: string): boolean {
    return this.flags[id] ?? featureDefault(id);
  }

  /** Resolves false for an id that is not a known flag. */
  async setFeature(id: string, on: boolean): Promise<boolean> {
    if (!isFeatureId(id)) return false;
    await this.turn(id, on);
    return true;
  }

  /** Stores the flag and resolves whether that changed it. The change callback has run by then. */
  turn(id: string, on: boolean): Promise<boolean> {
    return this.writes.run(WRITES, async () => {
      const was = this.featureOn(id);
      await this.store.setFeature(id, on);
      this.flags = { ...this.flags, [id]: on };
      if (was !== on) this.onChange(id, on);
      return was !== on;
    });
  }

  /** Every flag by id, as `StateBody.features` sends it to the console. */
  view(): Record<string, boolean> {
    return { ...this.flags };
  }
}

/** The wall's display settings (see `WallSettings`). */
export class LiveWallSettings {
  private shown: WallSettingsView = { notices: {}, showBackgroundSessions: false, cardTitleMachine: false };
  private dismissed: string | null = null;
  private readonly writes = new Serializer();

  constructor(
    private readonly store: WallSettingsApi,
    private readonly onChange: () => void = () => {},
  ) {}

  async load(): Promise<void> {
    [this.shown, this.dismissed] = await Promise.all([this.store.view(), this.store.updateDismissed()]);
  }

  noticeOn(id: string): boolean {
    return this.shown.notices[id] ?? true;
  }

  /** Resolves false for an id that is not a known notice. */
  setNotice(id: string, on: boolean): Promise<boolean> {
    if (!isNoticeId(id)) return Promise.resolve(false);
    return this.write(async () => {
      const { changed } = await this.store.setNotice(id, on);
      this.shown = { ...this.shown, notices: { ...this.shown.notices, [id]: on } };
      return changed;
    }).then(() => true);
  }

  showBackgroundSessions(): boolean {
    return this.shown.showBackgroundSessions;
  }

  setShowBackgroundSessions(on: boolean): Promise<void> {
    return this.write(async () => {
      const changed = await this.store.setShowBackgroundSessions(on);
      this.shown = { ...this.shown, showBackgroundSessions: on };
      return changed;
    });
  }

  cardTitleMachine(): boolean {
    return this.shown.cardTitleMachine;
  }

  setCardTitleMachine(on: boolean): Promise<void> {
    return this.write(async () => {
      const changed = await this.store.setCardTitleMachine(on);
      this.shown = { ...this.shown, cardTitleMachine: on };
      return changed;
    });
  }

  /** The newest release whose update notice someone closed (#499), or null. */
  updateDismissed(): string | null {
    return this.dismissed;
  }

  /** Hides the update notice for this release, for everyone; it only ever moves forward. */
  dismissUpdate(version: string): Promise<void> {
    return this.write(async () => {
      const changed = await this.store.dismissUpdate(version);
      if (changed) this.dismissed = version;
      return changed;
    });
  }

  view(): WallSettingsView {
    return { ...this.shown, notices: { ...this.shown.notices } };
  }

  /** Runs `change` after the writes before it, and tells the listeners when it reports a stored change. */
  private write(change: () => Promise<boolean>): Promise<void> {
    return this.writes.run(WRITES, async () => {
      if (await change()) this.onChange();
    });
  }
}

interface PriceState {
  overrides: PriceOverrides;
  pricing: Pricing;
  view: ModelPricesView;
}

/** The Admin's model prices (see `ModelPriceStore`): the pricing in force is read from memory, and a saved change shows in it at once. */
export class LiveModelPrices {
  private state: PriceState = { overrides: {}, pricing: new Pricing({}), view: { asOf: '', models: [] } };
  private readonly writes = new Serializer();

  constructor(
    private readonly store: ModelPricesApi,
    private readonly tx: Storage['tx'],
    private readonly onChange: () => void = () => {},
  ) {}

  async load(): Promise<void> {
    this.state = await this.read();
  }

  private async read(): Promise<PriceState> {
    const [overrides, view] = await Promise.all([this.store.overrides(), this.store.view()]);
    return { overrides, pricing: new Pricing(overrides), view };
  }

  overrides(): PriceOverrides {
    return this.state.overrides;
  }

  pricing(): Pricing {
    return this.state.pricing;
  }

  view(): ModelPricesView {
    return this.state.view;
  }

  /** Saves one row. Resolves with a message for an invalid row, `null` when it was saved (or changed nothing). */
  set(rawKey: string, body: Partial<ModelPrice>): Promise<string | null> {
    return this.change(async () => this.store.set(rawKey, body));
  }

  /** Removes the Admin's change from a row. */
  async reset(rawKey: string): Promise<void> {
    await this.change(async () => {
      await this.store.reset(rawKey);
      return null;
    });
  }

  /** Runs `op` and reads the prices back in one transaction, then holds them and tells the listeners if the overrides moved. */
  private change(op: () => Promise<string | null>): Promise<string | null> {
    return this.writes.run(WRITES, async () => {
      const { err, next } = await this.tx(async () => ({ err: await op(), next: await this.read() }));
      if (JSON.stringify(next.overrides) !== JSON.stringify(this.state.overrides)) {
        this.state = next;
        this.onChange();
      }
      return err;
    });
  }
}

/** The Admin's session recording limits (see `RecordingSettingsStore`). */
export class LiveRecordingSettings {
  private saved: RecordingSettings = { ...RECORDING_DEFAULTS };
  private readonly writes = new Serializer();

  constructor(private readonly store: RecordingSettingsApi) {}

  async load(): Promise<void> {
    this.saved = await this.store.get();
  }

  /** The saved settings; a missing or invalid field takes its default. */
  get(): RecordingSettings {
    return { ...this.saved };
  }

  /** Saves the given fields; see `RecordingSettingsStore.set`. */
  set(patch: Record<string, unknown>): ReturnType<RecordingSettingsApi['set']> {
    return this.writes.run(WRITES, async () => {
      const out = await this.store.set(patch);
      if (out.ok) this.saved = out.settings;
      return out;
    });
  }
}

/** The Admin's Activity history choice (see `ActivityHistorySettingsStore`). */
export class LiveActivityHistorySettings {
  private saved: ActivityHistorySettings = { ...ACTIVITY_HISTORY_DEFAULTS };
  private readonly writes = new Serializer();

  constructor(private readonly store: ActivityHistorySettingsApi) {}

  async load(): Promise<void> {
    this.saved = await this.store.get();
  }

  /** The saved settings; without a sign-in token the policy is always `default`. */
  get(): ActivityHistorySettings {
    return { ...this.saved };
  }

  /** Saves the given fields; see `ActivityHistorySettingsStore.set`. */
  set(patch: Record<string, unknown>): ReturnType<ActivityHistorySettingsApi['set']> {
    return this.writes.run(WRITES, async () => {
      const out = await this.store.set(patch);
      if (out.ok) this.saved = out.settings;
      return out;
    });
  }
}

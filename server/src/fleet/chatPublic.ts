// Opening, describing and removing a public channel (#1035). A public channel is a name, a description and an optional link to an issue, a milestone or a
// project, kept beside General in the public audience: everything said in one is readable by every signed-in person, every reporter and every Admin, so
// nothing here can reach a group or a Direct Message, and `chatSeparation.test.ts` holds this file to that. A person or an Admin opens one; its opener or an
// Admin edits the description; only an Admin removes one. An Admin who edits or removes a channel somebody else opened tells that person, in words, with who
// did it, in each of their live reporter sessions (PROJECT.md "An Admin Never Reads in Silence": an Admin's power to stop things is always told).
import { ADMIN_OWNER, nameKey } from '../storage/rows.js';
import { channelKey, linkRef, linkText } from '../storage/chatRows.js';
import type { PublicChannel, PublicChannelLinkKind, PublicChannelOutcome } from '../storage/types.js';
import type { AdminReads } from './chatAdminReads.js';
import type { ChatCore } from './chatCore.js';
import { channelScopePrefix, channelThread, fail, type ChatViewer, type Fail } from './chatTypes.js';

const MAX_LINK_REF_RAW = 400;

export class PublicChannels {
  constructor(
    private readonly core: ChatCore,
    private readonly reads: AdminReads,
  ) {}

  private get store() {
    return this.core.store;
  }

  /** Whether the viewer may change this channel's description: the person who opened it, or an Admin. */
  canEdit(viewer: ChatViewer, c: PublicChannel): boolean {
    return viewer.admin || (viewer.personId !== null && c.createdBy !== '' && c.createdBy === nameKey(viewer.name));
  }

  /** The refusal for a store's answer, in the words the New channel form shows. `name` and `link` are what was asked, to name what is already there. */
  private async refusal(out: Extract<PublicChannelOutcome, { ok: false }>, asked: { name?: string; link?: { kind: PublicChannelLinkKind; ref: string } | null }): Promise<Fail> {
    switch (out.error) {
      case 'name-taken':
        return fail(409, `There is already a channel called ${channelKey(asked.name ?? '')}. Open it, or pick another name.`, out.error);
      case 'link-taken': {
        const at = asked.link;
        const other = at ? (await this.store.channels.list()).find((c) => c.link?.kind === at.kind && c.link.ref.toLowerCase() === linkRef(at.kind, at.ref).toLowerCase()) : undefined;
        return fail(409, other ? `There is already a channel for ${other.link!.kind} ${linkText(other.link!.kind, other.link!.ref)}: ${other.name}. Open it instead.` : out.message, out.error);
      }
      case 'limit-reached':
        return fail(409, 'This server has 50 channels, the most it keeps. An Admin can remove one that is no longer used.', out.error);
      case 'not-found':
        return fail(404, 'There is no such channel.', out.error);
      default:
        return fail(422, out.message, out.error);
    }
  }

  /** What the body of a new channel asks for, or the refusal for a body that is not the right shape (the store judges the values). */
  private shape(body: Record<string, unknown>): { name: string; description: string; link: { kind: PublicChannelLinkKind; ref: string } | null } | Fail {
    if (typeof body.name !== 'string') return fail(400, 'name must be the channel\'s name.');
    if (body.description !== undefined && typeof body.description !== 'string') return fail(400, 'description must be text.');
    const raw = body.link;
    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw) || typeof (raw as Record<string, unknown>).kind !== 'string' || typeof (raw as Record<string, unknown>).ref !== 'string')) {
      return fail(400, 'link must be null, or an issue, milestone or project with its reference: { kind, ref }.');
    }
    const link = raw ? (raw as { kind: string; ref: string }) : null;
    return {
      name: body.name,
      description: typeof body.description === 'string' ? this.core.redact(body.description).trim() : '',
      // A reference is one short line, cut before it is cleaned, so the scan reads a bounded string; the store judges what is left (at most 100 characters).
      link: link ? { kind: link.kind as PublicChannelLinkKind, ref: this.core.label(link.ref.slice(0, MAX_LINK_REF_RAW)) ?? '' } : null,
    };
  }

  /** A person or an Admin opens a channel. The reply is the stored channel; a refusal says which field was wrong in `reason`. */
  async open(viewer: ChatViewer, body: Record<string, unknown>): Promise<{ ok: true; channel: PublicChannel } | Fail> {
    if (viewer.personId === null && !viewer.admin) return fail(403, 'Only a signed-in person or an Admin can open a channel.');
    const asked = this.shape(body);
    if ('ok' in asked) return asked;
    const out = await this.store.channels.create({ name: asked.name, description: asked.description, link: asked.link, createdBy: viewer.name }, this.core.host.now());
    if (!out.ok) return this.refusal(out, asked);
    this.core.onEvent({ kind: 'channel_opened', channel: out.channel.name, by: viewer.actor });
    this.core.signal({ scope: 'public', owner: null });
    return { ok: true, channel: out.channel };
  }

  /** The channel's opener or an Admin changes its description. An Admin who is not the opener tells the opener. */
  async describe(viewer: ChatViewer, name: string, body: Record<string, unknown>): Promise<{ ok: true; channel: PublicChannel } | Fail> {
    const c = await this.store.channels.get(name);
    if (!c) return fail(404, 'There is no such channel.');
    if (!this.canEdit(viewer, c)) return fail(403, `Only ${c.createdByName || 'the person who opened it'} or an Admin can change the description of ${c.name}.`);
    if (typeof body.description !== 'string') return fail(400, 'description must be text.');
    const out = await this.store.channels.updateDescription(c.name, this.core.redact(body.description).trim(), this.core.host.now());
    if (!out.ok) return this.refusal(out, { name: c.name });
    this.tellOpener(viewer, c, `edited the description of the channel ${c.name} you opened`);
    this.core.onEvent({ kind: 'channel_edited', channel: c.name, by: viewer.actor });
    this.core.signal({ scope: 'public', owner: null });
    return { ok: true, channel: out.channel };
  }

  /**
   * An Admin removes a channel with every message in it, and with what was kept about it: the flags of its pause and disconnect, the unread counts of every
   * person, and the Admin's records of it. The opener is told in each live session of theirs, in words, with who did it.
   */
  async remove(viewer: ChatViewer, name: string): Promise<{ ok: true; removed: number } | Fail> {
    if (!viewer.admin) return fail(403, 'Only an Admin can remove a channel.');
    const c = await this.store.channels.get(name);
    if (!c) return fail(404, 'There is no such channel.');
    const out = await this.store.channels.remove(c.name);
    if (!out.removed) return fail(404, 'There is no such channel.');
    const settings = this.store.settings;
    for (const scope of Object.keys(await settings.allFlags())) if (scope.startsWith(channelScopePrefix(c.name))) await settings.setFlags(scope, { paused: false, disconnected: false });
    await this.store.readState.forget(channelThread(c.name));
    await this.reads.forget(channelThread(c.name));
    this.tellOpener(viewer, c, `removed the channel ${c.name} you opened${out.messages ? `, with its ${out.messages} message${out.messages === 1 ? '' : 's'}` : ''}`);
    this.core.onEvent({ kind: 'channel_removed', channel: c.name, by: viewer.actor, messages: out.messages });
    this.core.signal({ scope: 'public', owner: null });
    return { ok: true, removed: out.messages };
  }

  /** An Admin did something to a channel somebody else opened: every live session of that person says who did what. Nothing for the Admin's own channel or one whose opener is gone. */
  private tellOpener(viewer: ChatViewer, c: PublicChannel, what: string): void {
    if (!viewer.admin || c.createdBy === '' || c.createdBy === nameKey(ADMIN_OWNER) || c.createdBy === nameKey(viewer.name)) return;
    for (const sessionId of this.reads.sessionsOf(c.createdBy)) this.reads.tell(sessionId, `${this.reads.who(viewer)} ${what}.`);
  }
}

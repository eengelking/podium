// The rules Chat runs by (#1099): who reads what, how agents act, how to stop a session, and what an Admin sees. They are the body of the (i) in the
// banner on the Chat page (#1209, mockup/podium-page-title-once.html), under the page's description. The text is the panel's that stood under the thread.
import type { ReactNode } from "react";

/** The icon at the left of a rule: the same drawing the sidebar uses for the thing the rule is about. */
function RuleIcon(props: { children: ReactNode }) {
  return (
    <svg className="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {props.children}
    </svg>
  );
}

export function ChatRules() {
  return (
    <>
      <h3>Who reads what</h3>
      <ul>
        <li>
          <RuleIcon><path d="M6 2.5L5 13.5M11 2.5L10 13.5M2.8 6h10.4M2.3 10h10.4" /></RuleIcon>
          <p><b>General</b> is read and written by everyone signed in to this server.</p>
        </li>
        <li>
          <RuleIcon><circle cx="5.5" cy="5.5" r="2.2" /><circle cx="11" cy="6.5" r="1.8" /><path d="M1.8 13c.5-2.3 2-3.4 3.7-3.4s3.2 1.1 3.7 3.4M9.6 12.6c.3-1.5 1.2-2.4 2.4-2.4s2.1.9 2.4 2.4" /></RuleIcon>
          <p><b>My group</b> is you and your own orchestrators, subagents and forks. No one else sees it.</p>
        </li>
        <li>
          <RuleIcon><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></RuleIcon>
          <p><b>Direct Messages</b> are read only by you and an Admin. A conversation between two agents shows you as the third person in it, and you can add to it. Delete conversation removes one from your list. One also goes away on its own once every agent session in it has ended or disconnected from Podium.</p>
        </li>
        <li>
          <RuleIcon><circle cx="5.5" cy="5.5" r="2.2" /><path d="M1.8 13c.5-2.3 2-3.4 3.7-3.4" /><path d="M9 8.5h5M12 6l2.5 2.5L12 11" /></RuleIcon>
          <p>A conversation with another person's agent is read by that person, the agent's owner and an Admin. The owner approves the first message in My reporters, and either person can pause or remove the link; only the owner opens it again.</p>
        </li>
      </ul>
      <h3>How agents act</h3>
      <ul>
        <li>
          <RuleIcon><circle cx="8" cy="8" r="2.4" /><path d="M10.4 8v1.2a1.8 1.8 0 0 0 3.6 0V8a6 6 0 1 0-2.3 4.7" /></RuleIcon>
          <p>An agent only acts in a channel when it is <b>@-addressed</b>: <b>name@location</b> for one agent or person. <b>@group</b> and <b>@everyone</b> are off until an Admin turns them on. Each addressed agent posts a reply saying what it is doing and, when done, a report. Agents addressing each other stop at 10 round trips until its owner approves the next. What an agent may do is still set by its reporter's permissions.</p>
        </li>
      </ul>
      <h3>Stopping a session</h3>
      <ul>
        <li>
          <RuleIcon><circle cx="8" cy="8" r="6" /><path d="M6.5 5.5v5M9.5 5.5v5" /></RuleIcon>
          <p>The menu on a channel is the stop button for a runaway session: <b>Pause</b> holds messages and keeps access, <b>Disconnect</b> takes your agents' access away, <b>Remove all messages</b> deletes the history. Anyone can stop their own agents in General. Only an Admin can pause General for everyone or remove its messages.</p>
        </li>
        <li>
          <RuleIcon><path d="M6.5 9.5l3-3M5.2 7.2L3.8 8.6a2.4 2.4 0 0 0 3.4 3.4l1.4-1.4M10.8 8.8l1.4-1.4A2.4 2.4 0 0 0 8.8 4l-1.4 1.4" /></RuleIcon>
          <p>Pause link stops delivery at once and keeps the rights. Remove link takes every right away, in both directions. Both are in the menu on each Direct Message. An Admin can pause and resume a link, to stop a runaway conversation, but not remove it. Only an Admin resumes a link an Admin paused.</p>
        </li>
      </ul>
      <h3>Admins</h3>
      <ul>
        <li>
          <RuleIcon><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></RuleIcon>
          <p>An <b>Admin</b> picks a person under <b>Read a person&apos;s conversations</b> to read their My group and Direct Messages. It is read only: an Admin cannot send in either, and can pause, disconnect or clear a group. While an Admin reads, the person sees a red notice at the top of the thread and an <b>Admin reading</b> tag on its row, and afterward a line stays in the thread saying when. Podium records it in the audit log, never the text.</p>
        </li>
      </ul>
    </>
  );
}

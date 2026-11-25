// What the person sees when the Direct Message they have open is concluded because an agent in it ended (#1283, mockup/podium-chat-dm-ended.html): the same read-only
// banner an Admin's reading uses (`.ch-nav.ro`), with the words and one way out. The conversation and its text are deleted, so nothing but this is left to show.
// Every word is a text node, and the banner is a polite status with an icon and words, never color alone.
import { undeliveredWords } from "../chatData";
import { ChInfo } from "./ChatIcons";

export function ConcludedBanner({ agent, cleared, undelivered, onBack }: { agent: string; cleared?: boolean; undelivered?: number; onBack: () => void }) {
  return (
    <div className="ch-nav ro" role="status" data-testid="chat-concluded">
      <ChInfo />
      <span>
        <b>
          <bdi>{agent}</bdi> {cleared ? "was cleared." : "ended."}
        </b>{" "}
        {cleared ? "It is still running under a new session. " : ""}This direct message has been concluded and deleted. Nothing in it is kept.{undeliveredWords(undelivered)}
      </span>
      <button type="button" className="btn sm" onClick={onBack}>
        Back to conversations
      </button>
    </div>
  );
}

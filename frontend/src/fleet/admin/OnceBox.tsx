// The show-once box (#587, T9): the token, the reporter config file, or both, right after Create user, Reissue config or a
// token rotation. It stays above the tabs. The file holds a private key and cannot be fetched again (SPEC 5.9, 7.7).
import { useState } from "react";
import type { ConfigFile } from "./adminApi";

export interface Created {
  name: string;
  /** Why the box is open: a new person (token and file), a reissue (file only) or a rotation (token only). */
  kind: "created" | "reissued" | "rotated";
  token?: string;
  config?: ConfigFile;
  /** The server made the person but not the certificate; the token is still here, once. */
  configError?: string;
}

const hintOf = (c: Created): string => {
  if (c.kind === "reissued") return `This is the only time this reporter config is shown. It replaces ${c.name}’s old certificate, which stops working now. It holds the new private key, and Podium keeps only the certificate.`;
  if (c.kind === "rotated") return `This is the only time the new token is shown. ${c.name}’s old token stops working now.`;
  if (!c.config) return `This is the only time the token is shown. Put these settings in ${c.name}’s reporter. The token does nothing without the matching name. It stays here while you switch tabs.`;
  return `This is the only time the token and the reporter config are shown. The token is for ${c.name}’s console sign-in. The reporter config is for their reporter: it holds the server address, the CA, their name, their certificate and its private key, and Podium keeps only the certificate.`;
};

/** Hands the browser a file to save. */
function save(f: ConfigFile) {
  const url = URL.createObjectURL(new Blob([f.content], { type: "application/x-pem-file" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = f.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function OnceBox({ c, onDone }: { c: Created; onDone: () => void }) {
  const [msg, setMsg] = useState("");
  const text = c.token === undefined ? "" : `userName: ${c.name}\ntoken: ${c.token}\nserverUrl: ${window.location.origin}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg("Copied.");
    } catch {
      setMsg("Could not copy. Select the text and copy it.");
    }
  };
  return (
    <section className="once" aria-labelledby="admin-once-h">
      <h2 id="admin-once-h">{c.config ? `Token and reporter config for ${c.name}` : `Token for ${c.name}`}</h2>
      <div className="hint ink2">{hintOf(c)}</div>
      {c.configError && (
        <div className="err" role="alert">
          {c.configError}
        </div>
      )}
      {c.token !== undefined && (
        <pre className="code" id="admin-once-code">
          {text}
        </pre>
      )}
      {c.config && (
        <div>
          <h3>Reporter config</h3>
          <pre className="code" id="admin-once-file">
            {c.config.filename}
          </pre>
          <ol className="plain">
            <li>
              Download the file and save it in <span className="mono">~/.podium/</span> on the machine where Claude Code runs. Every new Claude Code session on that machine uses it, and podium-reporter finds it there. Make it readable by you only (<span className="mono">chmod 600</span>).
            </li>
            <li>
              Keeping it in another folder? Set <span className="mono">PODIUM_REPORTER_CONFIG</span> to its full path in Claude Code’s <span className="mono">settings.json</span>:
              <pre className="code">{`{ "env": { "PODIUM_REPORTER_CONFIG": "/full/path/to/${c.config.filename}" } }`}</pre>
            </li>
          </ol>
          <p className="hint ink2">The file holds the CA, so nothing is installed on the machine. Start a new Claude Code session after you save it; a session that is already running does not pick it up. podium-reporter needs Node.js on the machine’s PATH.</p>
        </div>
      )}
      <div className="row2">
        {c.token !== undefined && (
          <button type="button" className="btn" onClick={copy}>
            Copy token settings
          </button>
        )}
        {c.config && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              save(c.config!);
              setMsg(`Saved ${c.config!.filename}.`);
            }}
          >
            Download reporter config
          </button>
        )}
        <button type="button" className="btn" onClick={onDone}>
          I have saved it
        </button>
        <span className="hint" role="status">
          {msg}
        </span>
      </div>
    </section>
  );
}

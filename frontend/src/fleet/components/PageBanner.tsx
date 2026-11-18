import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { fitSentences } from "../pageInfo";
import { Modal } from "./Modal";
import { WallOptions } from "./WallOptions";

/**
 * The banner under the top bar (#1209, mockup/podium-page-title-once.html): the page's description on one line, and the Wall options drawer at its right.
 * The page's name is the chip in the top bar and is not repeated here. The line is never more than one: the text stops at the middle of the banner
 * (or before the open drawer, whichever is nearer) and shows only whole sentences, as many as fit. When some are left out a (i) appears; hovering or
 * focusing it shows the standard tip and a click opens the modal, under the (i), with the full description. The drawer opens over the banner and never
 * makes it taller. `more` is extra content for the modal that also keeps the (i) always on (Chat's rules); `moreLabel` names the (i) then.
 */
export function PageBanner(props: {
  /** The page's name, for the modal's title. */
  name: string;
  description: string;
  wall: ComponentProps<typeof WallOptions>;
  more?: { label: string; tip: string; children: ReactNode };
}) {
  const { description, more } = props;
  const text = useRef<HTMLSpanElement>(null);
  const info = useRef<HTMLButtonElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);

  // Fit the text again when the description changes and when the banner changes size. The span has no React children: it is measured with each
  // candidate text in turn, so it is written here and nowhere else.
  const fit = useCallback(() => {
    const el = text.current;
    if (!el) return;
    const wrap = el.parentElement;
    wrap?.classList.remove("full");
    const fits = (s: string) => {
      el.textContent = s;
      return el.scrollWidth <= el.clientWidth + 1;
    };
    const { shown, clipped: some } = fitSentences(description, fits);
    el.textContent = shown;
    // Even the first sentence passes the cap: it takes the whole row (the drawer opens over it) rather than be cut inside the sentence.
    if (!fits(shown)) wrap?.classList.add("full");
    setClipped(some);
  }, [description]);

  useLayoutEffect(() => {
    fit();
    const root = text.current?.closest(".banner");
    if (!root || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(fit);
    watch.observe(root);
    return () => watch.disconnect();
  }, [fit]);

  const showInfo = clipped || more !== undefined;
  const label = more ? more.label : "Read the full description";
  const tip = more ? more.tip : "Click to read the full description";
  const close = () => {
    setOpen(false);
    info.current?.focus();
  };
  return (
    <div className="banner has-picker" role="region" aria-label="Display settings">
      <div className="bt-wrap">
        <span className="bt" ref={text} />
        {showInfo && (
          <button type="button" className="info" ref={info} aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={() => setOpen(true)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M8 7.2v4M8 4.8v.2" />
            </svg>
            <span className="tip" aria-hidden="true">
              {tip}
            </span>
          </button>
        )}
      </div>
      <WallOptions {...props.wall} />
      {open && (
        <Modal titleId="about-h" title={`About ${props.name}`} onClose={close} anchor={info.current}>
          <div className="mb rl">
            <p>{description}</p>
            {more && (
              <>
                <h3>{more.label}</h3>
                {more.children}
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

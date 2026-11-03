import { createContext, useContext } from "react";
import { DEFAULT_HARNESS, harnessOf, type HarnessDisplay } from "./harness";

/** The harness of the session whose feed, replay or answer panel is on screen, so a tool name is read the way that harness spells it (#853). */
export const HarnessContext = createContext<string>(DEFAULT_HARNESS);

export const useHarness = (): HarnessDisplay => harnessOf(useContext(HarnessContext));

// For tests (#1129): the display controls sit in the Wall options drawer, which starts shut, so a test that reads one opens it first.
import { fireEvent, screen } from "@testing-library/react";

/** Opens the Wall options drawer when it is shut; does nothing when it is open already. */
export function openWallOptions(): void {
  const pill = screen.queryByRole("button", { name: "Wall options" });
  if (pill) fireEvent.click(pill);
}

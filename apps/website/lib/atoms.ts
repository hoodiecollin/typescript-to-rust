import { atom } from "jotai";

/** Whether the ⌘K search palette is open. Shared by the trigger + the dialog. */
export const searchOpenAtom = atom(false);

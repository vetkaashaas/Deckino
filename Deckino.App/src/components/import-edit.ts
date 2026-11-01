import type { ImportLine } from '@/api/decks';
import type { SheetValues } from '@/components/card-sheet';

// The import review's lines live on that screen until the deck is made, so a row hands its line to the card sheet
// (app/import-card.tsx) and gets the changes back, as the printings grid does (printing-picker.tsx).

export interface ImportEdit {
  line: ImportLine;
  section: string;
  sections: { value: string; label: string }[];
  save: (values: SheetValues) => void;
  remove: () => void;
}

// ponytail: one edit at a time (the sheet is a modal), so one pending edit is enough
let pending: ImportEdit | null = null;

export const editImportLine = (edit: ImportEdit) => void (pending = edit);
export const importEdit = () => pending;

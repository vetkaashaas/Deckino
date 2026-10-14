import { File, Paths } from 'expo-file-system';
import { shareAsync, type ResolvedSharePayload } from 'expo-sharing';

/**
 * Shared into the app as a decklist: plain text (a link comes as a 'url' share). On Android expo-sharing reads a
 * text/plain share from its text only, so a .txt file shared from a file manager arrives empty: Import's Choose a
 * file opens those.
 */
export const isSharedList = (p: ResolvedSharePayload) => p.shareType === 'text' && p.value.trim() !== '';

/** Hands a deck or binder export to the share sheet as a file (`Goblins.txt`), so it can be sent or saved anywhere. */
export async function shareFile(name: string, contents: string, mimeType: string) {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  file.write(contents);
  await shareAsync(file.uri, { mimeType, dialogTitle: name });
}

/** The file name the website downloads with: letters, digits, spaces, - and _ kept, anything else a dash. */
export const fileName = (name: string, extension: string) =>
  `${name.replace(/[^\p{L}\p{N} _-]/gu, '-').trim() || 'deckino'}.${extension}`;

// Qalam learns from the writer's corrections. It remembers the form it last suggested for
// each word ("applied"); a marked word that differs from that, or that Qalam never
// suggested, is the writer's own version and is remembered as a correction. Next time
// that word appears without marks, the correction is used instead of the model's guess.

export interface TashkeelMemory {
  corrections: Record<string, string>; // bare word -> the writer's marked form
  applied: Record<string, string>; // bare word -> the form Qalam last put in the text
}

export const emptyMemory = (): TashkeelMemory => ({ corrections: {}, applied: {} });

const MARK = /[ً-ْ]/;
const MARKS_G = /[ً-ْ]/g;
const LETTER_OR_MARK = /[ء-يً-ْ]/;

/** Splits a whitespace-free token into surrounding punctuation and its Arabic core. */
function core(token: string): { lead: string; word: string; trail: string } {
  let start = 0;
  let end = token.length;
  while (start < end && !LETTER_OR_MARK.test(token[start])) start++;
  while (end > start && !LETTER_OR_MARK.test(token[end - 1])) end--;
  return { lead: token.slice(0, start), word: token.slice(start, end), trail: token.slice(end) };
}

const bare = (word: string) => word.replace(MARKS_G, "");
const tokens = (text: string) => text.split(/(\s+)/);

/** Records the writer's own marked words found in these paragraphs. Returns whether anything changed. */
export function learn(memory: TashkeelMemory, paragraphs: string[]): boolean {
  let changed = false;
  for (const text of paragraphs) {
    for (const token of tokens(text)) {
      const { word } = core(token);
      if (!MARK.test(word) || !/[ء-ي]/.test(word)) continue;
      const key = bare(word);
      if (memory.applied[key] !== word && memory.corrections[key] !== word) {
        memory.corrections[key] = word;
        changed = true;
      }
    }
  }
  return changed;
}

/** Puts remembered corrections into the model's result, for words the writer left bare. */
export function applyMemory(original: string, result: string, memory: TashkeelMemory): string {
  const a = tokens(original);
  const b = tokens(result);
  if (a.length !== b.length) return result;
  return b
    .map((token, i) => {
      const orig = core(a[i]).word;
      if (!orig || MARK.test(orig)) return token;
      const correction = memory.corrections[orig];
      const out = core(token);
      if (!correction || bare(out.word) !== orig) return token;
      return out.lead + correction + out.trail;
    })
    .join("");
}

/** Remembers the marked words now in these paragraphs as Qalam's own suggestions. */
export function recordApplied(memory: TashkeelMemory, paragraphs: string[]): void {
  for (const text of paragraphs) {
    for (const token of tokens(text)) {
      const { word } = core(token);
      if (MARK.test(word) && memory.corrections[bare(word)] !== word) memory.applied[bare(word)] = word;
    }
  }
}

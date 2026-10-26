/**
 * A chat title read off the first message, without a model.
 *
 * The title keeps the clause's content words in the order they were written,
 * so it reads as a sentence ("Add dark mode toggle to settings page") rather
 * than a keyword bag. Part-of-speech tags come from `compromise`, a rule-based
 * tagger: the same prompt always yields the same title.
 *
 * `promptTitleFields` is what a caller writes with the prompt; a prompt the
 * titler cannot read leaves the chat open, so the next message gets the try.
 */

import nlp from "compromise";

/** Content words a title keeps; glue words ride along for free. */
const MAX_WORDS = 6;
/** Below this a title says nothing ("Chat list"), so the caller quotes the prompt instead. */
const MIN_WORDS = 2;
/** Matches `ChatSession.title`. */
const MAX_LENGTH = 50;
/** A clause holds enough to name the chat; later ones are context. */
const MIN_WORDS_BEFORE_BREAK = 3;

/** Greeting and politeness scaffolding, says nothing about the topic. */
const FILLER_PREFIX =
  /^(?:(?:hi|hey|hello|yo|ok|okay|so|right|well)[,!.\s]+|(?:can|could|would|will) you(?: please)?\s+|please\s+|(?:i want to|i wanna|i need to|i'd like to|i would like to|let's|lets)\s+|(?:help me|tell me|show me|give me)\s+)+/i;

/** Determiners, pronouns and filler adverbs: they carry no topic. */
const DROPPED = new Set(
  `a an the this that these those my your our their his her its me you i we us them some any please just really very quite also too basically actually`.split(
    /\s+/,
  ),
);

const DROPPED_TAGS = ["Auxiliary", "Copula", "QuestionWord"];

/** A question's auxiliary ("does the prisma migration fail") carries no topic. */
const LEADING_AUXILIARIES = new Set(
  `do does did is are was were am be been can could should would will shall may might must have has had`.split(
    /\s+/,
  ),
);

/** A new phrase starts here; cutting before it beats trailing off mid-phrase. */
const SUBORDINATORS = new Set([
  "because",
  "since",
  "while",
  "when",
  "whenever",
  "which",
  "that",
  "who",
  "whom",
  "whose",
  "if",
  "though",
  "although",
  "unless",
  "until",
  "whereas",
  "after",
  "before",
]);

const PREPOSITIONS = new Set([
  "on",
  "in",
  "for",
  "with",
  "from",
  "to",
  "at",
  "about",
  "into",
  "of",
  "by",
  "over",
  "under",
  "between",
  "across",
  "through",
]);

/** Words a title can end up dangling with after a cut. */
const DANGLING = new Set([...SUBORDINATORS, ...PREPOSITIONS, "and", "or", "but"]);

/** Stands in for "-" while tagging, so "derive-title.ts" stays one word. */
const HYPHEN = "\u2011";

interface Term {
  text: string;
  pre?: string;
  post?: string;
  tags: string[];
}

function cleanPrompt(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`>#|]/g, " ")
    .replace(/(\w)-(\w)/g, `$1${HYPHEN}$2`)
    .replace(/\s+/g, " ")
    .trim();
}

function termsFor(text: string): Term[] {
  const json = nlp(text).json() as Array<{ terms?: Term[] }>;
  return json[0]?.terms ?? [];
}

function isGlue(word: string, tags: string[]): boolean {
  const lower = word.toLowerCase();
  return (
    PREPOSITIONS.has(lower) || tags.includes("Preposition") || lower === "and" || lower === "or"
  );
}

function isDropped(word: string, tags: string[]): boolean {
  return DROPPED.has(word.toLowerCase()) || DROPPED_TAGS.some((tag) => tags.includes(tag));
}

function deriveWords(prompt: string): string[] {
  const sentence = cleanPrompt(prompt).split(/(?<=[.!?])\s+/)[0] ?? "";
  const terms = termsFor(sentence.replace(FILLER_PREFIX, ""));

  const words: string[] = [];
  let gap = "";
  let content = 0;

  for (const term of terms) {
    // a negated auxiliary arrives as an empty term tagged Negative, keep the not
    const text = term.tags.includes("Negative") ? "not" : (term.text ?? "").trim();
    const before = gap + (term.pre ?? "");
    const after = term.post ?? "";
    const skip =
      !text ||
      isDropped(text, term.tags) ||
      (content === 0 && LEADING_AUXILIARIES.has(text.toLowerCase()));

    if (skip) {
      gap = before + text + after;
      continue;
    }
    if (
      content >= MIN_WORDS_BEFORE_BREAK &&
      (/[,;:]/.test(before) || SUBORDINATORS.has(text.toLowerCase()))
    )
      break;
    if (content >= MAX_WORDS) break;

    words.push(text);
    if (!isGlue(text, term.tags)) content++;
    gap = after;
  }

  return words;
}

/**
 * Title for a chat whose first message is `prompt`, or null when the prompt is
 * too short or too code-heavy to name a topic.
 */
export function deriveChatTitle(prompt: string): string | null {
  const words = deriveWords(prompt);

  // a cut can leave a preposition or a half-length title behind, drop the tail until it reads
  while (words.length > 0) {
    const last = words[words.length - 1]!.toLowerCase();
    if (DANGLING.has(last)) {
      words.pop();
      continue;
    }
    if (words.length > MIN_WORDS && words.join(" ").length > MAX_LENGTH) {
      words.pop();
      continue;
    }
    break;
  }
  if (words.length < MIN_WORDS) return null;

  let title = words.join(" ");
  if (title.length > MAX_LENGTH) {
    const cut = title.slice(0, MAX_LENGTH);
    const lastSpace = cut.lastIndexOf(" ");
    title = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  }
  if (title.length < MIN_WORDS) return null;

  return (title.charAt(0).toUpperCase() + title.slice(1)).replaceAll(HYPHEN, "-");
}

/** The title fields to write with a new message. */
interface PromptTitleFields {
  title: string;
  /** Set once the prompt named the chat; an unnamed one stays on "default". */
  titleSource?: "auto";
}

/** The prompt quoted as a title, for one the titler cannot read. */
function quotePrompt(promptText: string): string {
  const cut = promptText.slice(0, MAX_LENGTH - 3).trimEnd();
  return promptText.length > cut.length ? `${cut}...` : cut;
}

/**
 * The title fields to write with a new message, or null when the chat already
 * has a name (renamed, named on creation, or titled by the job).
 */
export function promptTitleFields(
  titleSource: string,
  promptText: string,
): PromptTitleFields | null {
  if (titleSource !== "default") return null;

  const derived = deriveChatTitle(promptText);
  if (derived) return { title: derived, titleSource: "auto" };

  const quoted = quotePrompt(promptText);
  return quoted ? { title: quoted } : null;
}

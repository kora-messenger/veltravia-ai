import type { TaskCategory } from '@veltravia/ai-router';

/**
 * Reads a prompt and says what kind of request it is, so Automatic can match a
 * model to it. Deliberately simple and deterministic: a few clear signals, a
 * safe default, and no model call (so it costs nothing and cannot fail).
 *
 * Only four kinds are returned, because those are the ones the connected
 * providers can all tell apart today:
 *  - coding: source code, errors, or a named programming language
 *  - image-understanding: the prompt is about an attached picture
 *  - complex-reasoning: long, multi-part, or explicitly analytical
 *  - general-conversation: everything else (the default)
 */
export type PromptCategory = Extract<
  TaskCategory,
  'general-conversation' | 'coding' | 'complex-reasoning' | 'image-understanding'
>;

const CODE_FENCE = /```|~~~/;
const CODE_SYNTAX =
  /\b(function|const|let|var|class|import|export|def|return|async|await|SELECT|INSERT|UPDATE|CREATE TABLE)\b[^.\n]{0,60}[({=;:]|=>|<\/?[a-z][a-z0-9]*[ >/]|\b\w+\(\)/;
const CODE_WORDS =
  /\b(coding|source code|my code|this code|the code|bug|debug|refactor|compile|compiler|stack ?trace|exception|typescript|javascript|python|java|kotlin|swift|rust|golang|c\+\+|c#|php|ruby|sql|html|css|react|node\.?js|api endpoint|regex|npm|git|docker|unit test|function|script|algorithm)\b/i;
const ERROR_NAMES =
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|NullPointerException|IndexError|KeyError|ValueError|AttributeError|ModuleNotFoundError|ImportError|segmentation fault|undefined is not|cannot read propert(y|ies)|is not a function|command not found|404 not found|npm ERR)\b/i;
/** Everyday phrases that contain a programming word without being about programming. */
const NOT_CODE =
  /\b(code of (conduct|ethics|honou?r)|dress code|zip code|area code|postal code|morse code|promo(tional)? code|discount code|tax code|penal code|html? email newsletter)\b/i;
const IMAGE_WORDS =
  /\b(this (image|picture|photo|screenshot|screen ?shot)|the (image|picture|photo|screenshot) (above|attached)|in (the|this) (image|picture|photo)|attached (image|picture|photo|screenshot)|what('s| is) in (the|this) (image|picture|photo))\b/i;
const REASONING_WORDS =
  /\b(analy[sz]e|compare|trade-?offs?|pros and cons|step by step|prove|derive|evaluate|strategy|architecture|design a|plan for|why does|explain why|root cause|optimi[sz]e|critique|decide between)\b/i;

/** Counts the separate asks in a prompt: numbered items, bullets, or several questions. */
function partCount(text: string): number {
  const numbered = (text.match(/^\s*(\d+[.)]|[-*•])\s+/gm) ?? []).length;
  const questions = (text.match(/\?/g) ?? []).length;
  return Math.max(numbered, questions);
}

export function classifyPrompt(
  task: string,
  options: { readonly hasImage?: boolean } = {},
): PromptCategory {
  const text = task.trim();
  if (options.hasImage === true) return 'image-understanding';
  if (text === '') return 'general-conversation';

  if (IMAGE_WORDS.test(text)) return 'image-understanding';
  if (
    CODE_FENCE.test(text) ||
    CODE_SYNTAX.test(text) ||
    ERROR_NAMES.test(text) ||
    (CODE_WORDS.test(text) && !NOT_CODE.test(text))
  )
    return 'coding';

  const long = text.length > 600;
  if (REASONING_WORDS.test(text) || partCount(text) >= 3 || long) return 'complex-reasoning';

  return 'general-conversation';
}

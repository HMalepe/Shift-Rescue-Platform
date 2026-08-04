/**
 * §6 — regex disintermediation detection.
 *
 * ## What this is for, and what it is emphatically not for
 *
 * The platform exists because booking through WhatsApp groups routes a locum
 * straight to a manager's personal number (§10.1). Two parties agreeing to
 * "just sort it out directly" is the failure mode that removes both of them
 * from the product — not because it costs a transaction fee (§10.0: the
 * platform never touches locum wages, so there is no fee to lose) but because
 * an off-platform shift has no verified pharmacist, no attendance record, and
 * no accountability if nobody arrives.
 *
 * So this is a **signal for humans**, not an enforcement mechanism. Nothing
 * here blocks, redacts, or delays a message. A flagged message is delivered
 * verbatim and a row is marked, and §14 is blunt about why: the false-positive
 * rate is unknown until a human labels the corpus, and blocking on an unvalidated
 * regex means silently breaking legitimate conversations between two people
 * trying to staff a pharmacy tomorrow morning.
 *
 * ## Why regexes at all, given that
 *
 * §6 asks for regexes specifically, and they have one property a classifier
 * does not: when a message is flagged, you can say exactly which rule fired
 * and read it. `flag_reason` carries that rule name into the database, so the
 * human adjudicating a flag sees "sa_mobile_number" rather than a confidence
 * score. That is the difference between a review queue someone can work and
 * one they learn to rubber-stamp.
 */

export interface DisintermediationSignal {
  /** Stable identifier, persisted in `messages.flag_reason`. */
  readonly rule: string;
  /** The matched substring, for the reviewer's context. Never stored. */
  readonly match: string;
}

export interface DisintermediationResult {
  readonly flagged: boolean;
  readonly signals: readonly DisintermediationSignal[];
  /** Rule names, comma-joined, truncated to the column width. */
  readonly reason: string | null;
}

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  /**
   * Rules that must NOT fire for this one to count.
   *
   * Cheaper and far more legible than trying to express "a phone number, but
   * not a time, and not a price" in a single regex.
   */
  readonly unless?: readonly RegExp[];
}

/*
 * South African mobile numbers are 10 digits starting 06/07/08, or +27
 * followed by 9. Separators vary wildly in practice, so they are permitted
 * between any two digits — but the *shape* is pinned, because loosening it to
 * "a long run of digits" flags every rand amount, ID number and date in the
 * product.
 */
const SEP = "[\\s.\\-()]{0,3}";
const D = (n: number) => `(?:\\d${SEP}){${n - 1}}\\d`;

const SA_MOBILE = new RegExp(
  `(?<![\\d])(?:(?:\\+?27${SEP}|0)(?:6|7|8)${SEP}${D(8)})(?![\\d])`,
  "i",
);

/**
 * Digits written as words, which is how someone shares a number once they
 * suspect the platform is looking for digits.
 *
 * Requires a run of five, because shorter runs appear innocently ("two or
 * three of us", "one nine hundred") and the point of five is that nobody says
 * five consecutive number-words by accident.
 */
const SPELLED_DIGITS =
  /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|nought|double|triple)\b(?:[\s,-]+\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|nought|double|triple)\b){4,}/i;

/**
 * Phrasings that explicitly keep the conversation *inside* the product.
 *
 * "Message me here", "call me through the app", "WhatsApp me on the app
 * number, not my personal one" — every one of these is someone doing exactly
 * what §10.1 wants, and every one trips a rule that keys on "message me" or
 * "WhatsApp". Suppressing on an explicit in-platform mention is principled
 * rather than a patch for the corpus: naming the platform is the strongest
 * available evidence of intent, and it points the opposite way.
 *
 * Applied only to the phrase rules. A message containing a literal phone
 * number is still flagged no matter how it is framed, because the number is
 * the thing that enables the off-platform contact regardless of the sentence
 * around it.
 */
const IN_PLATFORM_CARVE_OUT: readonly RegExp[] = [
  /\b(?:on|in|through|via)\s+(?:the\s+)?(?:app|platform|system|locum\s*planner)\b/i,
  /\b(?:message|msg|reply|write)\s+me\s+(?:on\s+)?here\b/i,
  /\bon\s+here\b/i,
  /\bnot\s+my\s+personal\b/i,
];

const RULES: readonly Rule[] = [
  { name: "sa_mobile_number", pattern: SA_MOBILE },
  { name: "spelled_out_number", pattern: SPELLED_DIGITS },
  {
    name: "email_address",
    pattern: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/i,
  },
  {
    name: "external_messenger",
    /*
     * Naming another channel is the clearest possible signal, and unlike the
     * phrase rules below it barely has a benign reading: there is no reason to
     * mention a Telegram handle to someone you are booking a shift with
     * through an app that already messages you on WhatsApp.
     */
    pattern:
      /\b(?:whats\s?app|wa\.me|telegram|signal|t\.me|instagram|\bIG\b|facebook|messenger)\b[\s:]*(?:me|number|@\w+|\+?\d)/i,
    unless: IN_PLATFORM_CARVE_OUT,
  },
  {
    name: "contact_me_directly",
    /*
     * Anchored on "me", which is the entire difference between this rule and a
     * useless one. §14 names "call the pharmacy" and "the manager will call
     * you about the roster" as known false positives, and a naive /call/ flags
     * both — the whole day's messages are people arranging to call each other
     * about legitimate things. What is being detected is not a call; it is
     * someone offering *themselves* as the channel.
     */
    pattern:
      /\b(?:call|whatsapp|text|message|contact|phone|ring|dial)\s+me\b/i,
    unless: IN_PLATFORM_CARVE_OUT,
  },
  {
    name: "my_number_is",
    pattern:
      /\b(?:my|his|her|their)\s+(?:cell|mobile|phone|number|digits|contact|line)\b\s*(?:is|:|-)?/i,
    unless: IN_PLATFORM_CARVE_OUT,
  },
  {
    name: "off_platform",
    /*
     * The intent stated in the open. Rarer than a bare phone number and much
     * stronger evidence, because a number can be shared for an innocent
     * reason and "let's skip the app" cannot.
     */
    pattern:
      /\b(?:off|outside|away\s+from|skip|bypass|avoid|without)\s+(?:the\s+)?(?:app|platform|system|site|locum\s*planner)\b|\b(?:sort|settle|arrange|handle|do)\s+(?:this|it|that)\s+(?:out\s+)?(?:directly|between\s+us|ourselves|privately|off\s*line)\b|\b(?:direct|private|cash)\s+(?:arrangement|deal|booking)\b/i,
  },
];

/** Column width of `messages.flag_reason`. */
const MAX_REASON_LENGTH = 120;

/**
 * Scans a message body.
 *
 * Pure and synchronous: no database, no I/O, no clock. That is what lets the
 * §14 corpus harness run the real detector over hundreds of messages rather
 * than a reimplementation of it, which is the only way the measured
 * false-positive rate describes the thing actually running in production.
 */
export function detectDisintermediation(body: string): DisintermediationResult {
  const signals: DisintermediationSignal[] = [];

  for (const rule of RULES) {
    const match = rule.pattern.exec(body);
    if (!match) continue;
    if (rule.unless?.some((exclusion) => exclusion.test(body))) continue;
    signals.push({ rule: rule.name, match: match[0] });
  }

  if (signals.length === 0) {
    return { flagged: false, signals: [], reason: null };
  }

  return {
    flagged: true,
    signals,
    reason: signals
      .map((signal) => signal.rule)
      .join(",")
      .slice(0, MAX_REASON_LENGTH),
  };
}

/** Rule names, for the corpus harness and for the admin review filter. */
export const DISINTERMEDIATION_RULES: readonly string[] = RULES.map((r) => r.name);

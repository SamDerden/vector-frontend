import { extractJson, ValidationContext } from "./validate";

const units = [
  "ноль",
  "один",
  "два",
  "три",
  "четыре",
  "пять",
  "шесть",
  "семь",
  "восемь",
  "девять",
];
const teens = [
  "десять",
  "одиннадцать",
  "двенадцать",
  "тринадцать",
  "четырнадцать",
  "пятнадцать",
  "шестнадцать",
  "семнадцать",
  "восемнадцать",
  "девятнадцать",
];
const tens = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const hundreds = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

function integerToRussianWords(value: string): string {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 999) {
    return [...value].map((digit) => units[Number(digit)]).join(" ");
  }
  if (number < 10) return units[number];
  if (number < 20) return teens[number - 10];
  const result = [hundreds[Math.floor(number / 100)]];
  const remainder = number % 100;
  if (remainder >= 10 && remainder < 20) {
    result.push(teens[remainder - 10]);
  } else {
    if (remainder >= 20) result.push(tens[Math.floor(remainder / 10)]);
    if (remainder % 10 > 0) result.push(units[remainder % 10]);
  }
  return result.filter(Boolean).join(" ");
}

function numberToRussianWords(value: string): string {
  const [integer, fraction] = value.split(/[.,]/);
  const words = integerToRussianWords(integer);
  return fraction ? `${words} целых ${integerToRussianWords(fraction)}` : words;
}

export function softSanitize(
  text: string,
  digitWhitelist: string[] = []
): string {
  const protectedTerms: { placeholder: string; term: string }[] = [];
  let protectedText = text;
  const terms = [...new Set(digitWhitelist)]
    .filter((entry) => /\d/.test(entry))
    .sort((left, right) => right.length - left.length);
  for (const [index, term] of terms.entries()) {
    const placeholder = `${String.fromCharCode(0xe000 + index)}${String.fromCharCode(0xe100 + index)}`;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    protectedText = protectedText.replace(new RegExp(escaped, "giu"), placeholder);
    protectedTerms.push({ placeholder, term });
  }

  const sanitized = protectedText.replace(/\d+(?:[.,]\d+)?/g, numberToRussianWords);
  return protectedTerms.reduce(
    (result, item) => result.replaceAll(item.placeholder, item.term),
    sanitized
  );
}

const textFields = new Set([
  "summary",
  "next_step",
  "warnings",
  "path_note",
  "tag",
  "why",
  "what_to_try",
  "watch_out",
]);

function sanitizeTextValues(value: unknown, key: string, context: ValidationContext): unknown {
  if (typeof value === "string" && textFields.has(key)) {
    return softSanitize(value, context.digitWhitelist);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTextValues(item, key, context));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      sanitizeTextValues(child, childKey, context),
    ])
  );
}

export function softSanitizeResponse(
  raw: string,
  context: ValidationContext
): string {
  const parsed = JSON.parse(extractJson(raw)) as unknown;
  return JSON.stringify(sanitizeTextValues(parsed, "", context));
}

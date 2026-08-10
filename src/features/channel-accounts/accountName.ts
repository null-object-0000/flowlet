export const ACCOUNT_NAME_MAX_DISPLAY_UNITS = 32;

const WIDE_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\uFF01-\uFF60\uFFE0-\uFFE6]/u;

export function getAccountNameDisplayUnits(value: string): number {
  return Array.from(value).reduce((total, character) => total + characterDisplayUnits(character), 0);
}

export function truncateAccountName(value: string): string {
  let result = "";
  let units = 0;

  for (const character of Array.from(value)) {
    const nextUnits = units + characterDisplayUnits(character);
    if (nextUnits > ACCOUNT_NAME_MAX_DISPLAY_UNITS) break;
    result += character;
    units = nextUnits;
  }

  return result;
}

function characterDisplayUnits(character: string): number {
  return WIDE_CHARACTER.test(character) ? 2 : 1;
}

// Who may use the app at all. Wikimedia now puts an hCaptcha challenge in
// front of edits by accounts that lack the `skipcaptcha` right, and the app
// edits through the API where it has no way to show one. So only accounts
// whose edits go through without a captcha may log in: those in a Wikidata
// group that carries `skipcaptcha` (autoconfirmed, confirmed, bot, sysop).
//
// https://www.mediawiki.org/wiki/Product_Safety_and_Integrity/hCaptcha
//
// The check reads the user's effective groups as the OAuth profile reports
// them (`autoconfirmed` is an implicit group and is listed there once the
// account qualifies), and the same snapshot is stored on the `users` row, so
// login, the session middleware, and the nightly re-check all agree.

/** Wikidata groups whose members skip the edit captcha. */
export const CAPTCHA_EXEMPT_GROUPS: readonly string[] = [
  "autoconfirmed",
  "confirmed",
  "bot",
  "sysop",
];

/** True when `groups` contains a group that is exempt from the edit captcha. */
export function isCaptchaExempt(groups: readonly string[] | null | undefined): boolean {
  return (groups ?? []).some((g) => CAPTCHA_EXEMPT_GROUPS.includes(g));
}

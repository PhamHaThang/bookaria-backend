export const VERIFY_EMAIL_TTL_HOURS = 24;
export const RESET_PASSWORD_TTL_MINUTES = 30;
/** Wrong passwords in a row before the account is locked for a while. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
/** At least this long between two "resend verification email" requests. */
export const RESEND_COOLDOWN_SECONDS = 60;
/** Forgot-password mails an address may get per hour. */
export const RESET_MAILS_PER_HOUR = 3;
/**
 * Two browser tabs may refresh at the same moment with the same cookie. A rotated token that shows
 * up again within this many seconds is treated as such a race, not as theft.
 */
export const REFRESH_GRACE_SECONDS = 10;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const REFRESH_TOKEN_COOKIE_NAME = 'bk_refresh';

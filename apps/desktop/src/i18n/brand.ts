// Brand names that are the same in every language. Written once here, so renaming one is a single line; both
// dictionaries read them from here. A brand name keeps its capitals inside a sentence (never "tu night plus").

/** The token the plan is paid with on the test network (the `TestToken` contract). It has no real value: the texts
 *  that name it say so. */
export const TOKEN_NAME: string = 'NightMail token';

/** Its plural, the same in both languages ("100 NightMail tokens", "pedir NightMail tokens"). */
export const TOKEN_NAME_PLURAL: string = 'NightMail tokens';

/** An amount of the token, as the core gives it (a whole number written as text): "1 NightMail token",
 *  "100 NightMail tokens". */
export const tokenAmount = (amount: string): string => `${amount} ${amount === '1' ? TOKEN_NAME : TOKEN_NAME_PLURAL}`;

/** The paid plan. */
export const PAID_PLAN: string = 'Night Plus';

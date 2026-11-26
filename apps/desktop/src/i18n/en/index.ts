// FROZEN: each namespace is filled only in its own `es/<namespace>.ts` and `en/<namespace>.ts` pair, so work on
// different namespaces in parallel does not clash. A shared text that is missing goes in the namespace of whoever
// needs it (it is sorted at the end).
import type { Messages } from '../index.ts';
import errors from './errors.ts';
import format from './format.ts';
import status from './status.ts';
import mail from './mail.ts';
import screensMail from './screensMail.ts';
import screensPlan from './screensPlan.ts';
import onboarding from './onboarding.ts';
import settings from './settings.ts';
import slogans from './slogans.ts';

/** All the English texts, with the same shape as Spanish. */
export const en = { errors, format, status, mail, screensMail, screensPlan, onboarding, settings, slogans } satisfies Messages;

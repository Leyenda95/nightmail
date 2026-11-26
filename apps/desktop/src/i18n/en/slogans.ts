// English texts of the `slogans` namespace: front screen slogans.
// Same shape as `es/slogans.ts`: `tsc -b` fails if a key is missing or extra.
// Same order as the Spanish ones.
import type { Messages } from '../index.ts';

export default {
  // Fixed headline above the rotating slogans: it never rotates and is always read.
  headline: "The world's most private email.",
  list: [
    "Even we can't connect the dots.",
    'No account. No phone number. No IP.',
    'Email privately. Sign up freely.',
    'Sign up anywhere. Share nothing.',
  ],
} satisfies Messages['slogans'];

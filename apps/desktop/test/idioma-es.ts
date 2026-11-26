// Pins Spanish in the tests. The app starts in English, but the older tests check the Spanish texts: each test file
// imports this one first. It is not a `*.test.ts`, so `node --test test/*.test.ts` does not run it on its own.
// The English tests set the language by hand and restore it.
import { prefs } from '../src/prefs.ts';

prefs.setLocale('es');

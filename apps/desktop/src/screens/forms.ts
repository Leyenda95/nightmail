// Form helpers for the screens. Kept apart from `common.tsx` because that file only exports components
// (oxlint's `react/only-export-components` rule).
import type { FormEvent } from 'react';

/** Handler of a `<form>`: submits with Enter without reloading the page. Whoever uses it adds its own guard (busy,
 *  empty fields), the same one that disables the button. */
export function onSubmitWith(submit: () => void) {
  return (e: FormEvent) => {
    e.preventDefault();
    submit();
  };
}

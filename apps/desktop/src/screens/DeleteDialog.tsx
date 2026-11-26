// Confirms "Borrar": there is no trash, so it asks. Destructive action: literal verb, danger button and focus on
// "Cancelar" (it comes first: `Dialogo` focuses the first control). On cancelling (button or Esc), `Dialogo` returns focus to "Borrar".
// It serves for one message (the reader) and for several (the list selection): `count` says how many. "Enviados" gives
// its own words (`words`): a sent message is only deleted from this device.
import { Dialogo } from '../components/Dialogo.tsx';
import { Icon } from '../components/Icon.tsx';
import { t } from '../i18n/index.ts';
import { deleteBody, deleteButton, deleteTitle } from '../selection.ts';

interface Props {
  count?: number;
  words?: { title: string; text: string; button: string };
  onYes: () => void;
  onNo: () => void;
}

export function DeleteDialog({ count = 1, words, onYes, onNo }: Props) {
  const footer = (
    <>
      <button type="button" className="button button-medium button-solid-weak nm-btn" onClick={onNo}>
        {t().screensMail.deleteDialog.cancel}
      </button>
      <button type="button" className="button button-medium button-solid-danger nm-btn" onClick={onYes}>
        <Icon name="trash" className="nm-ic" />
        {words?.button ?? deleteButton(count)}
      </button>
    </>
  );
  return (
    <Dialogo title={words?.title ?? deleteTitle(count)} size="s" footer={footer} onClose={onNo}>
      <p>{words?.text ?? deleteBody(count)}</p>
    </Dialogo>
  );
}

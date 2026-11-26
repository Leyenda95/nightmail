// Confirms "Abandonar" for an address, modelled on `DeleteDialog`: it cannot be undone, so it asks. Destructive
// action: danger button on the right and focus on "Cancelar" (it comes first: `Dialogo` focuses the first control).
// Esc cancels. The texts are in `addresses.ts` (`abandonTexts`).
import { abandonTexts } from '../addresses.ts';
import { Dialogo } from '../components/Dialogo.tsx';

interface Props {
  /** The address as shown in the row. */
  address: string;
  onYes: () => void;
  onNo: () => void;
}

export function AbandonAddressDialog({ address, onYes, onNo }: Props) {
  const text = abandonTexts();
  const footer = (
    <>
      <button type="button" className="button button-medium button-solid-weak nm-btn" onClick={onNo}>
        {text.no}
      </button>
      <button type="button" className="button button-medium button-solid-danger nm-btn" onClick={onYes}>
        {text.yes}
      </button>
    </>
  );
  return (
    <Dialogo title={text.title} size="s" footer={footer} onClose={onNo} described>
      <p className="text-monospace nm-filas__dir">{address}</p>
      {text.body.map((p) => (
        <p key={p}>{p}</p>
      ))}
    </Dialogo>
  );
}

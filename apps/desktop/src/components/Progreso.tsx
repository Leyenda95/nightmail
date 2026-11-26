// A long operation in progress (proof, payment, wallet, recovery): a beating light + the real stage the core sends
// (`progress.ts`) + why it takes long. No bar and no invented steps.
import { Luz } from './Luz.tsx';

export function Progreso({ stage, note }: { stage: string; note?: string }) {
  return (
    <div className="nm-progreso" role="status">
      <Luz mode="trabaja" />
      <div>
        <div className="nm-progreso__etapa">{stage}</div>
        {note && <div className="nm-progreso__nota">{note}</div>}
      </div>
    </div>
  );
}

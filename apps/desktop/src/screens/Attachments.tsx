// "Adjuntos (N)" fold at the foot of the reader. They are only shown: this version neither opens nor saves them. The
// name and type are written by the sender: the label comes from `attachmentRows` (clean name, real extension in view,
// declared type only if it matches it).
import { useMemo } from 'react';
import type { AttachmentView } from '../bindings/AttachmentView.ts';
import { Icon } from '../components/Icon.tsx';
import { attachmentRows } from '../format.ts';
import { t } from '../i18n/index.ts';
import { useLocale } from '../i18n/locale.ts';

interface Props {
  attachments: readonly AttachmentView[];
  /** Inline images visible in the mail (to label their duplicate attachment); empty if none is visible. */
  shownImages: readonly { mime: string; data: string }[];
}

export function Attachments({ attachments, shownImages }: Props) {
  // `attachmentRows` writes texts ("Sin nombre", the type): with another language they must be rebuilt.
  const locale = useLocale();
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the language is not read inside, but it changes the text produced.
  const rows = useMemo(() => attachmentRows(attachments, shownImages), [attachments, shownImages, locale]);
  if (rows.length === 0) return null;
  return (
    <details className="nm-pliegue">
      <summary>
        <Icon name="paper-clip" className="nm-ic" />
        {t().screensMail.attachments.title(rows.length)}
        <Icon name="chevron-down" className="nm-ic" />
      </summary>
      <div className="nm-pliegue__cuerpo">
        <ul className="nm-adjuntos">
          {rows.map((row, i) => (
            <li key={i}>
              <Icon name={row.icon} className="nm-ic" />
              {/* `dir="ltr"`: with RTL letters at the start, the real extension stays on the right. */}
              <bdi dir="ltr" className={row.muted ? 'nm-adjuntos__nombre nm-suave' : 'nm-adjuntos__nombre'}>{row.name}</bdi>
              <span>{row.meta}</span>
            </li>
          ))}
        </ul>
        <p className="nm-pista nm-pliegue__nota">{t().screensMail.attachments.note}</p>
      </div>
    </details>
  );
}

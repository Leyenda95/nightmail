// NightMail's own icon set (design/icons, generated from its SVG files by design/icons/tools/build.py). Each icon is
// inline markup on a 16 grid that carries its own stroke and fill and takes the text colour (`currentColor`).
// `espera` always spins: `Icon` adds `nm-espera__gira` (continuous, smooth spin), also with reduced motion (see
// app.css).
import { ICONS, type IconName } from '@nightmail/icons';

export type { IconName };

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  const icon = ICONS[name];
  return (
    <svg
      className={`${name === 'espera' ? 'nm-espera__gira keep-motion ' : ''}${className}`}
      width={size}
      height={size}
      viewBox={icon.viewBox}
      aria-hidden="true"
      // The markup comes from the files of design/icons, never from outside the app.
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}

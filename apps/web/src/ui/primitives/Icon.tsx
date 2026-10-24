import { ICONS, type IconName } from './icons.ts';

export type { IconName };

export function Icon({ name, size, className }: { name: IconName; size?: 'sm'; className?: string }) {
  const cls = ['icon', size, className].filter(Boolean).join(' ');
  return <svg className={cls} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] ?? '' }} />;
}

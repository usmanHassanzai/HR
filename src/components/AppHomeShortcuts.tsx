import type { ReactNode } from 'react';

export interface AppHomeShortcut {
  id: string;
  title: string;
  hint: string;
  icon: ReactNode;
  onClick: () => void;
}

export default function AppHomeShortcuts({
  items,
  title = 'Quick actions',
}: {
  items: AppHomeShortcut[];
  title?: string;
}) {
  return (
    <section className="app-home-shortcuts">
      <h2 className="app-home-shortcuts__title">{title}</h2>
      <div className="app-home-grid">
        {items.map((item) => (
          <button key={item.id} type="button" className="app-home-card" onClick={item.onClick}>
            <span className="app-home-card__icon">{item.icon}</span>
            <strong>{item.title}</strong>
            <span>{item.hint}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

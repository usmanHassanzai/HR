interface AdminHamburgerButtonProps {
  open: boolean;
  onClick: () => void;
  controlsId?: string;
}

export default function AdminHamburgerButton({ open, onClick, controlsId = 'admin-sidebar' }: AdminHamburgerButtonProps) {
  return (
    <button
      type="button"
      className={`admin-shell__hamburger ${open ? 'admin-shell__hamburger--open' : ''}`}
      onClick={onClick}
      aria-expanded={open}
      aria-controls={controlsId}
      aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
    >
      <span className="admin-shell__hamburger-box" aria-hidden>
        <span className="admin-shell__hamburger-line" />
        <span className="admin-shell__hamburger-line" />
        <span className="admin-shell__hamburger-line" />
      </span>
    </button>
  );
}

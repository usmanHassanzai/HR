interface AdminHamburgerButtonProps {
  open: boolean;
  onClick: () => void;
}

export default function AdminHamburgerButton({ open, onClick }: AdminHamburgerButtonProps) {
  return (
    <button
      type="button"
      className={`admin-shell__hamburger ${open ? 'admin-shell__hamburger--open' : ''}`}
      onClick={onClick}
      aria-expanded={open}
      aria-controls="admin-sidebar"
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

import { useMemo, useState } from 'react';
import { Mail, Send, Loader2, AlertCircle, CheckCircle2, Sparkles } from 'lucide-react';
import { Profile } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import { resetAndEmailLoginCredentials } from '../utils/credentialEmail';
import '../styles/admin-bulk-invite.css';

type Props = {
  users: Profile[];
  departments: Department[];
};

export default function AdminEmailPasswordsPanel({ users, departments }: Props) {
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState('');
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const recipients = useMemo(
    () =>
      users
        .filter((u) => Boolean(u.email?.trim()))
        .slice()
        .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [users],
  );

  const deptName = (id: string | null | undefined) =>
    id ? departments.find((d) => d.id === id)?.name ?? '' : '';

  const sendAll = async () => {
    if (recipients.length === 0) {
      setBanner({ type: 'err', text: 'No users with email addresses yet.' });
      return;
    }

    const confirmed = window.confirm(
      `Email a new temporary password to all ${recipients.length} users?\n\nThis resets each password and emails it from Scorr. Current passwords will stop working.\n\nContinue?`,
    );
    if (!confirmed) return;

    setBanner(null);
    setSending(true);
    let ok = 0;
    let fail = 0;

    for (let i = 0; i < recipients.length; i++) {
      const user = recipients[i]!;
      setProgress(`Emailing ${i + 1} of ${recipients.length}: ${user.full_name}…`);
      try {
        await resetAndEmailLoginCredentials({
          userId: user.id,
          email: user.email,
          fullName: user.full_name,
          role: user.role,
          departmentName: user.role !== 'admin' ? deptName(user.department_id) : undefined,
        });
        ok += 1;
      } catch {
        fail += 1;
      }
    }

    setSending(false);
    setProgress('');
    setBanner({
      type: fail === 0 ? 'ok' : 'err',
      text:
        fail === 0
          ? `Sent login passwords to all ${ok} users via Scorr email.`
          : `Finished: ${ok} sent, ${fail} failed.`,
    });
  };

  return (
    <section className="admin-bulk-invite glass-panel">
      <div className="admin-bulk-invite__head">
        <div className="admin-bulk-invite__title">
          <Mail size={20} />
          <div>
            <h3>Email passwords to all</h3>
            <p>
              One click sends a fresh temporary password to every employee, manager, and admin.
              For a single person, use the mail icon in the user directory below.
            </p>
          </div>
        </div>
        <div className="admin-bulk-invite__actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={sending || recipients.length === 0}
            onClick={() => void sendAll()}
          >
            {sending ? <Loader2 size={16} className="spin-icon" /> : <Send size={16} />}
            {sending ? 'Sending…' : `Email passwords to all (${recipients.length})`}
          </button>
        </div>
      </div>

      {progress && (
        <div className="admin-bulk-invite__hint" role="status">
          <Loader2 size={14} className="spin-icon" aria-hidden />
          <p>{progress}</p>
        </div>
      )}

      {banner && (
        <div
          className={`admin-bulk-invite__banner ${banner.type === 'ok' ? 'admin-bulk-invite__banner--ok' : 'admin-bulk-invite__banner--err'}`}
          role="status"
        >
          {banner.type === 'ok' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          <span>{banner.text}</span>
        </div>
      )}

      <div className="admin-bulk-invite__hint">
        <Sparkles size={14} aria-hidden />
        <p>
          Sent from Scorr (<strong>noreply@scorr.walfia.ai</strong>). Each send sets a new temporary
          password because passwords are not stored in plain text.
        </p>
      </div>
    </section>
  );
}

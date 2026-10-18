---
title: "Email notifications"
summary: "Configuring SMTP, where the password is stored, testing it, and the per-routine controls."
order: 12
readmeLines:
  - "1429-1468"
---
## Email Notifications

Email notifications are transactional SMTP messages emitted by `email_notifier.py` + `email_sender.py` on routine completion. They are opt-in at two levels: the global SMTP configuration lives under **Settings → Email**, and each routine owns its own per-routine **Email** and **Results-in-Email** toggles that gate whether that specific routine notifies on completion and whether the AI summary is inlined in the body.

### Configuring SMTP

Open **Settings → Email** (`#/settings/email`) and fill in the transport fields:

| Field | Purpose |
|---|---|
| `smtp_server` | Outbound SMTP host (e.g. `smtp.gmail.com`, `smtp.office365.com`). |
| `smtp_port` | Port (`587` for STARTTLS, `465` for implicit TLS, `25` for plain). |
| `smtp_username` | Authenticating username. |
| `smtp_from` | `From:` address on outgoing notifications. |
| `smtp_to` | Default recipient address used by routines. |

Press **Save** to persist the transport fields through `PUT /api/settings/email`.

### Storing the SMTP Password

The SMTP password is stored **separately** from the transport fields, in the OS keychain under the credential name `smtp_password`:

1. Type the password into the password field.
2. Click **Store password**. The frontend strips whitespace from the input before sending (so a Gmail App Password — which Google's UI presents as four space-separated groups — becomes the raw 16-character secret) and issues `PUT /api/credentials/smtp_password`.
3. The UI afterwards sees only a presence boolean from `GET /api/credentials`; the password itself is never returned.
4. Use **Remove password** (`DELETE /api/credentials/smtp_password`) to clear it.

### Testing the Configuration

Click **Send test email** to issue `POST /api/settings/email/test`. The backend composes a minimal test message, binds to the stored SMTP server, authenticates with the stored credential, and returns a success or `Error:` status line that is surfaced inline in the panel.

### Per-Routine Controls

When SMTP is configured, a routine emits notifications only when its **Email** toggle is on. Two additional per-routine flags refine the behavior:

- **Results-in-Email** — inlines the AI summary inside the email body.
- **Notify-on-Completion** — independent desktop notification raised on fire completion; it does not depend on SMTP.

The execution bundle produced by the shared export pipeline (`/api/executions/export`) is attached to the email when the total size is within the configured limit.

/**
 * J23 Notifications and email — the test send says which way it failed, the
 * settings survive the window closing, and the password is not one of them.
 *
 * Three things a person does here, and each is asserted where the evidence
 * actually is.
 *
 * **Before anything is configured**, Send Test Email must not silently do
 * nothing. It names what is missing, which is the difference between a feature
 * that is off and a feature that is broken.
 *
 * **Pointed somewhere that refuses the connection**, the test send fails and
 * says so. The address is a port the operating system had just told this run
 * was free and which nothing is now listening on — a number written into a spec
 * would be somebody's real service one day.
 *
 * **Across a relaunch**, every field comes back except the password, which was
 * never a setting: it goes to the machine's own credential store and only the
 * fact of it returns.
 *
 * **Two things this row does not establish, both printed below.**
 *
 * *A successful send — unbuilt, not unbuildable.* An earlier reading of this
 * said a loopback stub could not work because `starttls()` is called with no
 * SSL context. That was wrong: `smtplib.SMTP.starttls(context=None)` builds
 * `ssl._create_stdlib_context()`, which has `check_hostname=False` and
 * `verify_mode=CERT_NONE`, so a self-signed certificate on loopback would be
 * accepted. The work is generating a certificate and answering `AUTH` — real
 * work, and not done here. The success path's evidence is for now the backend
 * suite, which patches `smtplib`; this row owes the arm rather than being
 * unable to hold it.
 *
 * *The notification itself.* A desktop notification for a manual run is raised
 * by the renderer, through the browser `Notification` API, with no IPC and no
 * artefact. Nothing outside the window can observe one. What this row asserts
 * instead is that the preference a person sets is the preference the app keeps,
 * which is the half that can be measured.
 */
import { expect, journey } from './driver';

const EMAIL = {
  server: '127.0.0.1',
  port: '',
  username: 'journey@fixture.invalid',
  sender: 'journey@fixture.invalid',
  recipients: 'someone@fixture.invalid',
};

journey.describe('J23 Notifications and email', () => {
  journey('the test send names how it failed, and the preferences survive a relaunch', async ({ resmon }) => {
    await resmon.open('Email settings');

    // Nothing configured yet: the app says what is missing rather than
    // reporting a send it never attempted.
    const unconfigured = await resmon.sendATestEmail();
    console.log(`[J23] with nothing configured: ${JSON.stringify(unconfigured)}`);
    expect(unconfigured.toLowerCase(), 'the test send claimed to have sent something')
      .not.toContain('test email sent');
    expect(unconfigured, 'the app does not say what is missing').toMatch(/SMTP|configur/i);

    // Now point it somewhere that genuinely refuses the connection.
    const nowhere = await resmon.anAddressThatRefusesConnections();
    console.log(`[J23] pointing SMTP at ${nowhere.host}:${nowhere.port}, where nothing is listening`);
    await resmon.configureEmail(
      { ...EMAIL, server: nowhere.host, port: String(nowhere.port) },
      'journey-smtp-password-never-real',
    );

    const refused = await resmon.sendATestEmail();
    console.log(`[J23] against a closed port: ${JSON.stringify(refused)}`);
    expect(refused.toLowerCase(), 'a test send against a closed port reported success')
      .not.toContain('test email sent');
    expect(refused, 'the failure does not tell the person what to check')
      .toMatch(/failed/i);

    // The settings survive the window closing — and the password does not come
    // back with them, because it was never stored beside them.
    await resmon.reopenTheApp();
    const back = await resmon.readEmailSettings();
    console.log(`[J23] after a relaunch: ${JSON.stringify(back)}`);
    expect(back.server).toBe(nowhere.host);
    expect(back.port).toBe(String(nowhere.port));
    expect(back.username).toBe(EMAIL.username);
    expect(back.recipients).toBe(EMAIL.recipients);
    const everyField = Object.values(back).join(' ');
    expect(everyField, 'the SMTP password came back in the settings')
      .not.toContain('journey-smtp-password-never-real');

    // The notification preferences: set them, close the window, read them back.
    await resmon.setNotificationPreferences({
      whenIRunSomethingMyself: false, forAutomaticRoutines: 'all',
    });
    await resmon.reopenTheApp();
    const preferences = await resmon.readNotificationPreferences();
    console.log(`[J23] notification preferences after a relaunch: ${JSON.stringify(preferences)}`);
    expect(preferences).toEqual({ whenIRunSomethingMyself: false, forAutomaticRoutines: 'all' });

    console.log('[J23] NOT VERIFIED: a successful test send. This arm is UNBUILT, not unbuildable '
      + '— `starttls(context=None)` uses a stdlib context with CERT_NONE and no hostname check, so '
      + 'a loopback STARTTLS stub with a self-signed certificate would be accepted. What it needs '
      + 'is a certificate and an AUTH responder, and this slice did not write them. For now the '
      + 'success path is the backend suite, which patches `smtplib`.');
    console.log('[J23] NOT VERIFIED: the desktop notification itself. It is raised in the '
      + 'renderer through the browser Notification API, with no IPC and no artefact, so nothing '
      + 'outside the window can observe one. The preference is asserted above; the dispatch '
      + 'decision is `test_desktop_notifications.py`.');

    await resmon.takePicture('J23-notifications-and-email');
    expect(resmon.refusedConnections()).toEqual([]);
  });
});

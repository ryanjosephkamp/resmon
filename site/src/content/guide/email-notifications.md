---
title: "Email, delivery, and notifications"
summary: "Email, folder, feed, and webhook delivery, how a delivery is recorded, and desktop notifications."
order: 12
---
When a watch finishes a run, resmon can notify you, email you the report, and send it on to a folder, a feed, or a webhook. Where reports go is set per watch. The mail account and the notification rules are set once, in **Settings**. This page covers all three, and how resmon records whether a report arrived.

## Email

Email goes through your own mail provider's SMTP server. resmon has no mail server of its own.

Open **Settings › Email** and fill in:

| Field | What it is |
|---|---|
| **SMTP server** | Your provider's outgoing mail host, such as `smtp.gmail.com` |
| **Port** | 587 for STARTTLS |
| **Username** | The account that signs in |
| **From** | The address the report comes from |
| **To** | One or more addresses, separated by commas |

Press **Save**. The **Password** is separate. Type it and press **Store**. It goes to your operating system's keychain, never to resmon's database, and the page only ever learns whether one is stored. **Replace** and **Remove** change or clear it. resmon reads the password only to send.

**Send a test email** sends one message to the first address in **To** with what is saved. If you changed a field, the button says **Save and send a test email** and saves first, so a test is never run against values you have already replaced. The result is either a sentence naming the inbox to check (including its spam folder) or the mail server's refusal.

The page also lists which watches email their reports.

### Which watches email

Email is opt in, per watch. On a watch's page, **Email the report** turns it on, and **Attach its results to the email** (in the watch editor) attaches the run's bundle: its report, with a PDF and LaTeX where they could be made, its log, its metadata, and its search record. A watch's email goes to the address under **Where reports go**, or to **To** in Settings if that is left blank. A watch with email on and no complete account under **Settings › Email** fails each delivery, and says so under **Where reports go**.

## Where reports go

A **destination** sends a watch's report somewhere. Add and change them on a watch's **Where reports go** tab. See [Watches and people](/resmon/guide/watches/) for the controls. There are four kinds:

- **Email**, described above.
- **Folder.** resmon writes the report bundle, unpacked, into a folder you choose, with a `delivery.json` naming the run and the report's hash. It writes to a temporary name and renames it into place, so a sync client watching the folder never uploads a half-written report. This is how iCloud, Dropbox, OneDrive, a shared drive, or Google Drive for desktop can carry reports with no code of resmon's on the wire.
- **Feed.** An Atom file in a folder you choose, keeping the newest 50 reports, newest first. A feed reader or a static site can read it. Every string in it is escaped, and it holds no script, no tracker, and no secret.
- **Webhook.** An `https` address you own receives a signed JSON envelope for each run: the watch and run, when it finished, how many results and how many were new, the coverage sentence, the report's hash, a link to the search record, and the report bundle. The bundle arrives as a link that stays good for 24 hours, or inside the envelope if you tick the box. resmon signs every envelope with a shared secret you store for that destination, in your keychain. A destination with no secret is never sent to. [`docs/delivery.md`](docs/delivery.md) is the contract for whoever writes the receiving end.

Each destination is **Sent when a run finishes** or **Waits for you to release it**. A delivery waiting for review sits there, through restarts, until you press **Deliver** (or **Skip** to decide not to send it). Nothing else promotes it, ever.

### Whether it got there

Each delivery has a row in the watch's record: which run, which destination, the state, and the reason it has not arrived. The states are **Queued**, **Sending**, **Delivered**, **Failed, trying again**, **Failed**, **Skipped**, and **Waiting for you**. A retryable failure is tried again after 1 minute, then 5 minutes. After three attempts in all it stops and waits for you to press **Retry**, which starts the attempts again. A terminal refusal stops without retrying.

Delivery happens after the run, on its own queue, so a slow mail server does not hold the run's place.

The record says what resmon did: it handed the message to your mail server, wrote the files into the folder, or got a success reply from your receiver. Whether a message reached an inbox, whether a folder finished syncing, and what a receiver did with the envelope afterward are things resmon cannot see, and the panel says so. The webhook link is the one route resmon serves without its local API token, so a receiver does not need a credential that opens every route.

## Notifications

**Settings › Notifications** sets when resmon posts a desktop notification. Clicking one opens the run. Whether it shows, and how, is up to your operating system's notification settings for resmon.

- **When a search I start finishes** notifies you about Deep Dives, Deep Sweeps, and finds (Find a paper). A find's notification says how many of the sources it asked hold the paper.
- **When a watch finishes** is **Every watch** or **Only the watches set to notify**. A watch whose own **Notify me when it finishes** switch is on notifies whichever you choose, and the page lists those watches.

A watch run by the background service notifies you whether or not a window is open.

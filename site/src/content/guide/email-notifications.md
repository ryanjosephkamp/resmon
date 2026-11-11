---
title: "Email, Delivery, and Notifications"
summary: "Email, folder, feed, and webhook delivery, how a delivery is recorded, and desktop notifications."
order: 12
---
When a watch finishes a run, resmon can notify you, email you the report, and send it on to a folder, a feed, or a webhook. **Where Reports Go** is set per watch. The mail account and the notification rules are set once, in **Settings**. This page covers all three, and how resmon records whether a report arrived.

## Email

Email goes through your own mail provider's SMTP server. resmon has no mail server of its own.

Open **Settings › Email** and choose a **Provider**. **Gmail** and **iCloud Mail** fill in the server and port, and say the one step each asks for first:

- **Gmail** does not accept your Google Account password here. Turn on 2-Step Verification, then make an app password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and store it as the password. The username is your full Gmail address. Some work, school, and Advanced Protection accounts do not offer app passwords.
- **iCloud Mail** does not accept your Apple Account password here. Sign in at [account.apple.com](https://account.apple.com), choose **Sign-In and Security**, then **App-Specific Passwords**, and store the password it makes. The account needs two-factor authentication. The username is your full iCloud Mail address.
- **Other** is any provider's SMTP server, from its own help pages. Outlook.com is not offered: Microsoft's page lists OAuth2 as the only sign-in for its SMTP server, and resmon signs in with a username and a password.

Then fill in what is left:

| Field | What it is |
|---|---|
| **SMTP server** | Your provider's outgoing mail host, such as `smtp.gmail.com` |
| **Port** | 465 is encrypted from the start; any other port, usually 587, is encrypted with STARTTLS before anything is sent |
| **Username** | The account that signs in |
| **From** | The address the report comes from; the username when empty |
| **To** | One or more addresses, separated by commas |

Either way, resmon checks the server's certificate before it sends the password, and sends nothing to a server whose certificate a known authority did not sign for its name.

Press **Save**. The **Password** is separate. Type it and press **Store**. It goes to your operating system's keychain, never to resmon's database, and the page only ever learns whether one is stored. **Replace** and **Remove** change or clear it. resmon reads the password only to send.

**Send a Test Email** sends one message from **From** to the first address in **To** with what is saved. If you changed a field, the button says **Save and Send a Test Email** and saves first, so a test is never run against values you have already replaced. The result is either a sentence naming the inbox to check (including its spam folder) or why it was not sent: the server that could not be found or refused the connection, a certificate that could not be verified, or the mail server's own refusal, such as a sign-in it did not accept. The reason never shows the password or an address.

The page also lists which watches email their reports.

### Which Watches Email

Email is opt in, per watch. On a watch's page, **Email the report** turns it on, and **Attach its results to the email** (in the watch editor) attaches the run's bundle: its report as a web page, as Markdown, and as a PDF where a LaTeX engine could make it; its papers as BibTeX, RIS, and CSV; its search record and metadata; and its log. A watch's email goes to the address under **Where Reports Go**, or to **To** in Settings if that is left blank. A watch with email on and no complete account under **Settings › Email** fails each delivery, and says so under **Where Reports Go**.

## Where Reports Go

A **destination** sends a watch's report somewhere. Add and change them on a watch's **Where Reports Go** tab. See [Watches and People](/resmon/guide/watches/) for the controls. There are four kinds:

- **Email**, described above.
- **Folder.** resmon writes the report bundle, unpacked, into a folder you choose, with a `delivery.json` naming the run and the report's hash. It writes to a temporary name and renames it into place, so a sync client watching the folder never uploads a half-written report. This is how iCloud, Dropbox, OneDrive, a shared drive, or Google Drive for desktop can carry reports with no code of resmon's on the wire.
- **Feed.** An Atom file in a folder you choose, keeping the newest 50 reports, newest first. A feed reader or a static site can read it. Every string in it is escaped, and it holds no script, no tracker, and no secret. An entry links, by a path relative to the feed file, to the report bundle that a Folder destination of the same watch wrote; without one, it has no link.
- **Webhook.** An `https` address you own receives a signed JSON envelope for each run: the watch and run, when it finished, how many results and how many were new, the coverage sentence, the report's hash, a link to the search record, and the report bundle. The bundle arrives as a link that stays good for 24 hours, or inside the envelope if you tick the box. resmon signs every envelope with a shared secret you store for that destination, in your keychain. A destination with no secret is never sent to. [`docs/delivery.md`](docs/delivery.md) is the contract for whoever writes the receiving end.

Each destination is **Sent when a run finishes** or **Waits for you to release it**. A delivery waiting for review sits there, through restarts, until you press **Deliver** (or **Skip** to decide not to send it). Nothing else promotes it, ever.

### Whether It Got There

Each delivery has a row in the watch's record: which run, which destination, the state, and the reason it has not arrived. The states are **Queued**, **Sending**, **Delivered**, **Failed, trying again**, **Failed**, **Skipped**, and **Waiting for you**. A retryable failure is tried again after 1 minute, then 5 minutes. After three attempts in all it stops and waits for you to press **Retry**, which starts the attempts again. A terminal refusal stops without retrying.

Delivery happens after the run, on its own queue, so a slow mail server does not hold the run's place.

The record says what resmon did: it handed the message to your mail server, wrote the files into the folder, or got a success reply from your receiver. Whether a message reached an inbox, whether a folder finished syncing, and what a receiver did with the envelope afterward are things resmon cannot see, and the panel says so. The webhook link is the one route resmon serves without its local API token, so a receiver does not need a credential that opens every route.

## Notifications

**Settings › Notifications** sets when resmon posts a desktop notification. Clicking one opens the run. Whether it shows, and how, is up to your operating system's notification settings for resmon.

- **When a search I start finishes** notifies you about Deep Dives, Deep Sweeps, and finds (Look Up a Paper). A find's notification says how many of the sources it asked hold the paper.
- **When a watch finishes** is **Every watch** or **Only the watches set to notify**. A watch whose own **Notify me when it finishes** switch is on notifies whichever you choose, and the page lists those watches.

A finished run's notification says how many of its sources answered, and what happened to each of the rest: "2 of 4 sources answered; bioRxiv was stopped by you; arXiv did not answer." A source that rate-limited the run is said to have been rate-limited, with "try again after about 3:40 PM" where it gave a time. Up to three sources are named for each, and more are counted.

A watch run by the background service notifies you whether or not a window is open.

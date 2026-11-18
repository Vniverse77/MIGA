# Notifications

## What works in v0.6.0

- **Unread counters** per chat (badge in the chat list) and in the window or tab title, for example `(3) MIGA`.
  They are stored next to the chats (IndexedDB, `meta` store, keys `unread` and `muted`) and survive a reload.
  Control messages (delivery and read receipts, delete requests, sync between your own devices) never count.
  A chat that is open and visible does not count; opening a chat clears its counter.
- **Mute per chat** (chat menu, or right-click on desktop). A muted chat still counts unread messages in the
  list but never notifies and is left out of the title total. The muted list is synced to linked devices.
- **Web:** the Notification API, only while MIGA is open in a tab or window and that chat is not in front.
  Permission is asked only after a click on "Turn on notifications" (banner in the chat list, or the settings
  card). Never at start. One notification per chat (the `tag` replaces the previous one). A click focuses the
  window and opens that chat.
- **Desktop (Tauri 2):** the official notification plugin (libnotify on Linux). The desktop plugin cannot report
  clicks or replace a shown notification, so those two web features do not exist there. Closing the window hides
  it to the tray icon so the relay connection stays alive; "Quit" in the tray menu ends the app. If the tray
  cannot be created, closing the window quits as before.
- **Content privacy** (per device, setting "What a notification shows"): name and message, name only (default),
  or only "New message".

## What does not work: the app is fully closed

A closed browser tab or a stopped app holds no connection to the relay, so nothing can notify. Closing this gap
needs a way to wake the device. Decide before the Android build.

| Option | How it works | Pros | Cons |
|---|---|---|---|
| **UnifiedPush** | The user installs a distributor app (ntfy, Conversations, etc.). MIGA registers an endpoint with it; the relay posts an empty wake-up to that endpoint when a message arrives; the app then connects and fetches the sealed envelope. | No Google. Works on F-Droid builds. User can self-host the push server. Payload is empty, so nothing readable leaves the relay. | Extra app to install, less polished first run. The relay learns a push endpoint per device and must make outgoing requests (needs abuse limits). Web push is a separate, similar mechanism (VAPID) with browser-vendor servers in the path. |
| **FCM** | The Play Services push channel. | Works on nearly every Android phone with one tap. Reliable, battery-friendly. | Google sees a device token and the timing of every wake-up for every message, and a Google dependency makes the F-Droid build impossible without a separate flavour. Conflicts with MIGA's no-account, no-tracking position. |
| **Foreground service connection** | The Android app keeps its own websocket to the relay in a foreground service with a permanent notification. | No third party at all. Simple on the relay (nothing new). Works on F-Droid. | A permanent status notification, more battery use, and some vendors (Xiaomi, Huawei, Samsung) kill background services unless the user whitelists the app. Needs the battery-optimisation prompt. |

### Recommendation

Ship Android first with the **foreground service connection** (no relay change, no third party, fits the
privacy rules and F-Droid), with a clear first-run screen for battery optimisation. Add **UnifiedPush** as an
opt-in second step for people who want a quieter phone. Do not build FCM unless a Play Store flavour is
required later, and then keep it a separate flavour with empty payloads.

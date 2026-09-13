# macOS permissions: why "blocked" notifications appear, and what to grant by hand

**English** · [繁體中文](macos-permissions.md)

> The README's install section has the short version. This is the full explanation, and how to verify it yourself.

## 1. "Fledge was blocked from accessing Contacts / Calendar"

### What you see

Notification Center shows "Fledge was blocked from accessing Contacts", "…Calendar", "…Apple Events" or similar. No permission prompt — straight to "blocked".

### Why it's blocked

1. Claude Code is a child process of Fledge. The process tree is `Fledge.app → fledge-sidecar → claude → zsh → …`.
2. macOS's TCC (the mechanism that governs privacy permissions) decides based on the **top-level app**. So any command Claude Code runs inside Fledge, and any program that command launches — Chrome, Playwright, `osascript` — gets charged to Fledge when it touches Contacts, Calendar, or Apple Events.
3. Fledge is a hardened-runtime app and **doesn't declare** those entitlements. TCC's rule for that case is: deny outright, no prompt, post a "blocked" notification.

The time this was actually hit, a Claude Code conversation ran `Google Chrome --headless=new --screenshot=…` to take a screenshot. Chrome probes Contacts, Calendar, and Apple Events on launch; all three were blocked, three notifications appeared. The screenshot itself succeeded — only Chrome's side queries were blocked.

### macOS is right to block it

- Fledge's own code never touches Contacts, Calendar, or Accessibility. The Rust shell's only dependencies are `tauri`, `tauri-plugin-opener`, `tauri-plugin-dialog`, `tauri-plugin-clipboard-manager` (see `src-tauri/Cargo.toml`).
- Fledge **deliberately doesn't** add those entitlements. Adding them would turn "silently blocked" into a "Fledge wants to access Contacts" prompt — more annoying, and it would open the door for every child process.

### How to verify

```bash
/usr/bin/log show --last 1h --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS[c] "fledge"' --style compact
```

You'll see `tccd`'s records for `dev.fledge.app`, including which child process triggered each one.

There's one other kind of record: the Fledge main process checks the Accessibility permission every time the system appearance switches. That's AppKit's internal behavior — a query, not a denial, no notification — and can be ignored.

## 2. Permissions you grant by hand

### Full Disk Access

**When it's needed**: when Claude Code inside Fledge has to read protected paths like `~/Library/…`. Without it Fledge still works; those paths just return:

```
Operation not permitted
```

**How to grant it**: System Settings › Privacy & Security › Full Disk Access › add **Fledge.app**.

**Pick Fledge.app, not `claude`.** Same reason as above — TCC looks at the top-level app. This is the part people get wrong most often.

### The grant expires after every update

Fledge is currently ad-hoc signed. For an ad-hoc-signed app, TCC records the grant against the hash of that specific binary; every rebuild changes the hash, and TCC no longer recognizes it as the same app. The result: **the grant is void, but the switch in System Settings still shows it as on.**

The symptom is that Full Disk Access looks enabled yet reading `~/Library` still returns `Operation not permitted`. The log shows records like:

```
tccd: Failed to match existing code requirement for subject dev.fledge.app and service kTCCServiceSystemPolicyAllFiles
```

**Workaround for now**: after an update, go to System Settings and toggle Fledge's Full Disk Access off and back on. If you ever enabled "App Management", do the same there.

**The real fix**: sign with a stable identity, so TCC records the certificate rather than a hash. It's on the roadmap. Once it lands, this section becomes "grant it once".

<!-- Update this section after ticket 22 lands -->

## 3. Gatekeeper is a separate matter

"App is damaged and can't be opened" is Gatekeeper reacting to an unsigned app; it has nothing to do with the TCC story above. The fix is in the README's install section: System Settings › Privacy & Security › Open Anyway, or `xattr -dr com.apple.quarantine /Applications/Fledge.app`. Installing via the `curl` script doesn't hit it.

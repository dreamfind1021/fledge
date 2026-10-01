# macOS permissions: why "blocked" notifications appear, and what to grant by hand

**English** · [繁體中文](macos-permissions.md)

> The README's install section has the short version. This is the full story, plus how to verify it yourself.

## 1. "Fledge was blocked from accessing Contacts / Calendar"

### What you see

Notification Center shows "Fledge was blocked from accessing Contacts", "…Calendar", "…Apple Events", or similar. There's no permission prompt — it goes straight to "blocked".

### Why it's blocked

1. Claude Code is a child process of Fledge. The process tree is `Fledge.app → fledge-sidecar → claude → zsh → …`.
2. macOS's TCC (the mechanism that governs privacy permissions) makes its decision based on the **top-level app**. So any command Claude Code runs inside Fledge, and any program that command launches — Chrome, Playwright, `osascript` — is charged to Fledge the moment it touches Contacts, Calendar, or Apple Events.
3. Fledge is a hardened-runtime app and **doesn't declare** those entitlements. TCC's rule for that case is: deny outright, no prompt, post a "blocked" notification.

The time this actually happened, a Claude Code conversation ran `Google Chrome --headless=new --screenshot=…` to take a screenshot. Chrome probes Contacts, Calendar, and Apple Events on launch; all three were blocked and three notifications appeared. The screenshot itself succeeded — only Chrome's side queries were blocked.

### macOS is right to block it

- Fledge's own code never touches Contacts, Calendar, or Accessibility. The Rust shell's only dependencies are `tauri`, `tauri-plugin-opener`, `tauri-plugin-dialog`, `tauri-plugin-clipboard-manager` (see `src-tauri/Cargo.toml`).
- Fledge **deliberately doesn't** add those entitlements. Adding them would turn a silent block into a "Fledge wants to access Contacts" prompt — more annoying, and it would open the door for every child process.

### How to verify

```bash
/usr/bin/log show --last 1h --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS[c] "fledge"' --style compact
```

You'll see `tccd`'s records for `dev.fledge.app`, including which child process triggered each one.

You'll also see one other kind of record: the Fledge main process checks the Accessibility permission every time the system appearance switches. That's AppKit's internal behavior — a query, not a denial, and it never produces a notification — so it can be ignored.

## 2. Permissions you grant by hand

### Full Disk Access

**When you need it**: when Claude Code inside Fledge has to read protected paths like `~/Library/…`. Without it, Fledge still works; those paths just come back with:

```
Operation not permitted
```

**How to grant it**: System Settings › Privacy & Security › Full Disk Access › add **Fledge.app**.

**Pick Fledge.app, not `claude`.** Same reason as above — TCC looks at the top-level app. This is the part people get wrong most often.

### Grant it once (1.9.1 and later)

When TCC records a grant, it also records a rule for "what counts as the same app", and checks every later request against that rule.

- **1.9.0 and earlier** were ad-hoc signed, so the rule pinned the hash of that specific binary. Every rebuild changes the hash, so after an update the rule no longer matched and the grant stopped working.
- **From 1.9.1** Fledge is signed with a stable self-signed certificate, so the rule pins the certificate. Updates keep the same certificate, so the grant stays.

**Coming from 1.9.0 or earlier**: the old and new rules differ, so after the first update turn Fledge's Full Disk Access on once more in System Settings. After that, you're done.

**Exception: running a differently signed Fledge on the same Mac**, such as one you built from source with ad-hoc signing. The moment it touches a protected path, TCC records a denial that replaces the existing grant: the switch in System Settings turns **off**, and reading `~/Library` returns `Operation not permitted`. Turn it back on in System Settings. The log shows records like:

```
tccd: Failed to match existing code requirement for subject dev.fledge.app and service kTCCServiceSystemPolicyAllFiles
```

If you ever enabled "App Management", do the same there.

**Check it yourself**:

```bash
codesign -d -r- /Applications/Fledge.app
```

`certificate leaf = H"…"` means the stable identity; `cdhash H"…"` means the old ad-hoc signature.

## 3. Gatekeeper is a separate matter

"App is damaged and can't be opened" is Gatekeeper reacting to an app that hasn't been notarized by Apple; it has nothing to do with the TCC story above. The fix is in the README's install section: System Settings › Privacy & Security › Open Anyway, or `xattr -dr com.apple.quarantine /Applications/Fledge.app`. Installing with the `curl` script never hits it.

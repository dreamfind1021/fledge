# macOS 權限：為什麼會跳「已阻擋」、哪些要手動給

[English](macos-permissions.en.md) · **繁體中文**

> README 安裝段有短版。這裡講完整的原因，以及怎麼驗證。

## 一、「已阻擋 Fledge 取用聯絡人／行事曆」

### 現象

通知中心出現「已阻擋 Fledge 取用聯絡人」「…行事曆」「…Apple Events」之類的訊息。沒有詢問框，直接就是「已阻擋」。

### 為什麼會被擋

1. Claude Code 是 Fledge 的子程序。程序樹是 `Fledge.app → fledge-sidecar → claude → zsh → …`。
2. macOS 的 TCC（管隱私權限的那個機制）判定權限時，看的是**最上層的 app**。所以 Claude Code 在 Fledge 裡跑的任何指令、它再叫起來的任何程式——Chrome、Playwright、`osascript`——要碰聯絡人、行事曆、Apple Events 時，帳都記在 Fledge 頭上。
3. Fledge 是 hardened runtime，而且**沒有宣告**這些權限（entitlement）。TCC 對這種情況的規則是：直接拒絕、不彈詢問框、發一則「已阻擋」通知。

實際遇到的一次，是一場 Claude Code 對話跑了 `Google Chrome --headless=new --screenshot=…` 截圖。Chrome 一啟動就去問聯絡人、行事曆、Apple Events，三個都被擋，三則通知就跳了。截圖本身照樣成功——被擋的只是 Chrome 順手做的查詢。

### macOS 擋得沒錯

- Fledge 自己的程式碼沒有碰聯絡人、行事曆、Accessibility。Rust 殼的依賴只有 `tauri`、`tauri-plugin-opener`、`tauri-plugin-dialog`、`tauri-plugin-clipboard-manager`（見 `src-tauri/Cargo.toml`）。
- Fledge **刻意不**加這些 entitlement。加了會從「靜默阻擋」變成「Fledge 想存取聯絡人」的詢問框——更擾人，而且等於替所有子程序開門。

### 怎麼驗證

```bash
/usr/bin/log show --last 1h --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS[c] "fledge"' --style compact
```

會看到 `tccd` 對 `dev.fledge.app` 的紀錄，以及是哪個子程序觸發的。

還有一種紀錄：Fledge 主程序每逢系統外觀切換就查一次 Accessibility 權限。那是 AppKit 內部行為，只是查詢、不是拒絕、不會發通知，可以忽略。

## 二、需要手動授予的權限

### 完整磁碟取用權限

**什麼時候需要**：Fledge 裡的 Claude Code 要讀 `~/Library/…` 這類受保護路徑時。不授也能用，只是那些路徑會回：

```
Operation not permitted
```

**怎麼授**：系統設定 › 隱私權與安全性 › 完整磁碟取用權限 › 加入 **Fledge.app**。

**選的是 Fledge.app，不是 `claude`。** 理由同上——TCC 看最上層 app。這點最容易搞錯。

### 授權一次就好（1.9.1 起）

TCC 記錄授權時，會一併記下「怎樣才算同一個 app」的規則，之後每次都拿這條規則比對。

- **1.9.0（含）以前**用的是臨時簽章（ad-hoc），規則記的是那份二進位檔的雜湊。每次重新打包雜湊都會變，更新後就對不上，授權因此失效。
- **1.9.1 起**改用固定的自建憑證簽章，規則記的是憑證。更新後憑證不變，授權會留著。

**從 1.9.0（含）以前更新上來**：新舊規則不同，更新後第一次讀受保護的路徑一定會被擋，系統設定裡的開關也會變成關。這時把它打開、重開 Fledge 即可，之後就不用了。在被擋之前先去切開關沒有用，那只會改到舊版的紀錄。

**例外：同一台 Mac 上執行過簽章不同的 Fledge**，例如自己從原始碼用 ad-hoc 打包的版本。它一碰到受保護的路徑，TCC 就會記下一筆「拒絕」取代原本的授權：系統設定裡的開關會變成**關**，讀 `~/Library` 回 `Operation not permitted`。到系統設定再打開即可。log 裡會有這種紀錄：

```
tccd: Failed to match existing code requirement for subject dev.fledge.app and service kTCCServiceSystemPolicyAllFiles
```

「App 管理」如果也開過，同樣處理。

**自己確認是不是固定身分**：

```bash
codesign -d -r- /Applications/Fledge.app
```

看到 `certificate leaf = H"…"` 就是固定身分；看到 `cdhash H"…"` 是舊的臨時簽章。

## 三、Gatekeeper 是另一回事

「Apple 無法驗證…是否為惡意軟體」是 Gatekeeper 對未經 Apple 公證（notarization）的檔案的反應，跟上面的 TCC 無關。從瀏覽器下載時，dmg 和裡面的 Fledge 各會被擋一次。解法在 README 安裝段：打開 dmg 前先移除它的隔離標記，或到系統設定 › 隱私權與安全性按「強制打開」。用 `curl` 腳本裝的不會遇到。

/**
 * 「這支檔案是被直接執行的嗎？」——**唯一實作**。
 *
 * ⚠️ **本檔自理財 webapp repo 原樣移植**（2026-08-25 分家）。以下註解點名的考題
 *    （`test/entry-guard.test.js`）與事故編號**都在 webapp、不在本 repo**。
 *    ⚠️ **兩個坑在本 repo 都成立，整段照用**：坑①（symlink）在 `/private/tmp` 的審查樹會踩到；
 *    坑②（百分號編碼）也會——**repo 名字是英文，但父目錄不是**。實測輸出：
 *    `file:///Users/teacherjung/Desktop/07%20%E5%B0%88%E6%A1%88/teaching-videos/lib/is-main.js`
 *    （`%20`＝空格、`%E5%B0%88%E6%A1%88`＝「專案」）。
 *    ⚠️ `Codex #514 r3` 時我把坑②寫成「本 repo 不成立」＝**反向的錯誤**：為了修一句「保證超過實況」，
 *    反手把一個成立的坑說成不成立（r4 抓到）。根因＝看到 repo 名是英文就以為整條路徑是 ASCII——
 *    **「檔名一律用英文」管的是 repo 內的檔名，管不到父目錄**。
 *
 * 為什麼要有這支：**理財 webapp** 原本有六個地方各寫一份這個判斷，而且**六份寫法都不一樣**
 * （`resolve()`／裸字串比對／`|| ''`／`realpathSync`）。它們錯的時候**不會叫**：
 * 判斷成 false ⇒ `main()` 不跑 ⇒ 退出碼 0 ⇒ 對呼叫者來說就是**「這道閘通過了」**。
 * **一道靜靜回報通過的閘，比沒有閘更糟。**（2026-08-03 在 #388 實際踩到：
 * 把閘複製到 `/tmp/xgate.mjs` 執行，完全沒有輸出、exit 0。）
 *
 * 兩個坑，缺一不可：
 *
 * ① **symlink**：macOS 的 `/tmp` 其實是 `/private/tmp` 的 symlink。Node 給的
 *    `import.meta.url` 是**解析過** symlink 的真實路徑（`/private/tmp/…`），
 *    而 `process.argv[1]` 是**你打進去的樣子**（`/tmp/…`）——兩邊永遠比不相等。
 *    ⇒ 至少要 `realpathSync(argv[1])`。
 *    **兩邊都做**是因為 `--preserve-symlinks-main` 之下 Node 連 `import.meta.url`
 *    都不解析，只修一邊當場就錯（**webapp** 的考題 `test/entry-guard.test.js` 有一條專門跑那個旗標——
 *    沒有那條的話，「兩邊都要」就只是我說說而已。⚠️ **本 repo 沒有那條考題**）。
 *
 * ② **百分號編碼**（⚠️ **兩個 repo 都會踩**，見上方檔頭的實測 URL）：路徑含中文與空格，`import.meta.url` 會編碼成
 *    `%E6%A6%AE…`，所以不能拿 `file://${argv[1]}` 這種裸字串去比。
 *    ⇒ 統一轉成**檔案系統路徑**再比（不是轉成 URL 再比）。
 *
 * ⚠️ **刻意不 try/catch**：萬一 `realpathSync` 丟例外（檔案不存在），
 *    吞掉它就會回 false ⇒ 又變成「靜靜不執行」，正是本檔要根治的病。
 *    讓它**大聲炸掉**：閘炸掉＝非零退出＝擋下來（fail-closed），
 *    server 炸掉＝看得到堆疊，而不是「啟動了但沒在聽」。
 *    （實務上這兩個路徑都是正在執行中的檔案，不可能不存在。）
 *
 * @param {string} importMetaUrl 呼叫端的 `import.meta.url`
 * @returns {boolean} 這支檔案就是本次執行的進入點
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;   // 例如 `node -e '…'`：沒有進入點檔案
  return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry);
}

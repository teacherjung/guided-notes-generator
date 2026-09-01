// @ts-check
// **叫 git 做事之前，把 git 的環境變數清乾淨**——這是 2026-08-09 事故的修法收成的單一實作。
//
// ## 為什麼需要這一份
//
// ⚠️ **本檔自理財 webapp repo 原樣移植**（2026-08-25 分家）。以下註解描述的 `pre-push`、
//    `npm test`、`scripts/check-worktree-integrity.js` 與那次事故**都在 webapp、不在本 repo**
//    （本 repo 沒有 pre-push、沒有 npm test、沒有那支腳本）。整段保留是因為它解釋了這個函式
//    為什麼存在——那個道理跨 repo 成立；被點名的設施不成立（`Codex #514 r3`）。
//
// ⚠️ 下方所有 PR 編號（含 `#433 r15`）都是 **webapp** 的，不是本 repo 的。
//
// git 有一族環境變數會讓它**不看你給的路徑、改看環境**。最要命的是 `GIT_DIR`：
// 它一存在，`git -C <路徑>` 與 `execFileSync(…, { cwd })` 就形同無效——**cwd 隔離不了它**。
//
// 而它不需要有人手動設：**git 自己會放進 hook 的環境**（從連結工作樹 push 時，
// `pre-push` 拿得到 `GIT_DIR=<主目錄>/.git/worktrees/<名>`）。**webapp** 的 `pre-push` 會跑
// `npm test` ⇒ 整套考題都在那個環境下跑。兩個後果，機制與實測寫在
// `scripts/check-worktree-integrity.js` 的檔頭（那裡是單一真相，這裡不重抄——抄兩份就會漂）：
//   ① 那個環境下的 `git init` 會把 `bare = true` 寫進**共用** `.git/config`
//      ⇒ 主目錄與全部連結工作樹同時失去工作樹身分，而做這件事的考題**顯示通過**。
//   ② 宣稱「掃這棵樹」的考題其實掃到 `GIT_DIR` 那一棵，於是靜靜掃了別棵、回報「零違規」。
//
// ⇒ 所以規矩是：**每一處 spawn git（或 spawn 會再去叫 git 的東西）都要走這裡。**
//
// ## 為什麼按前綴整族清，不列名
//
// 列名補不完，而且已經補不完過兩次：`git rev-parse --local-env-vars` 那批之外還有
// `GIT_CONFIG_PARAMETERS` 與 `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`（`git -c` 就會生出來、
// **會長的一族**——它們能注入 `core.excludesFile` 讓 `--exclude-standard` 靜靜隱藏違規新檔），
// 還有 `GIT_EXEC_PATH` 等。列舉繞法補不完就要關門，前綴是唯一關得起來的門。

/**
 * ⚠️ **`GITHUB_*` 不受影響**：第四個字元是 `H` 不是底線，不符合 `GIT_` 前綴。
 *    這不是巧合而是必須成立的事——CI 靠 `GITHUB_TOKEN`，前綴寫鬆成 `GIT` 就會誤殺它。
 *
 * ⚠️ **誠實劃界：本函式只清 `GIT_` 前綴，`HOME` 與 `PATH` 刻意不動。**
 *   - `PATH` 非留不可：清掉就找不到 git 執行檔，全部呼叫端一起紅。
 *   - `HOME` 是**另一個問題**，不在本函式射程內：`~/.gitconfig` 的 `core.excludesFile`
 *     也能左右 ignore 規則（#433 r15 實測，用 global `include.path` 引入）。刻意不清的理由是
 *     **清了也關不起來**——同族還有 `.git/info/exclude`，那是固定路徑，連 `git -c` 都蓋不掉。
 *     ⇒ 清 `HOME` 只買得到部分保護，代價卻是多開一個入口讓呼叫端挑（挑錯就靜靜沒防護）。
 *     這條通道的射程只及於 `--others --exclude-standard`（列**未追蹤**檔）那一族；
 *     已追蹤檔（`--cached`）不受 ignore 規則影響。要守未追蹤檔的完整性得換作法，**未做**。
 *
 * @param {NodeJS.ProcessEnv} [env] 要清的環境（預設 `process.env`）
 * @returns {NodeJS.ProcessEnv} 新的一份，原本那份不動
 */
export function gitEnv(env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('GIT_')) out[key] = value;
  }
  return out;
}

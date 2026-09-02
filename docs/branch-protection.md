# 分支保護設定與驗證（main）

2026-09-01 建立。**這是一份人工維護的紀錄**——GitHub 上被改了它不會知道，以 GitHub 現況為準。

## 設定值

| 項目 | 值 | 為什麼 |
|---|---|---|
| required status checks | `協作欄位（實作者 ≠ 獨立審查者）` | 逐字比對 workflow 的 job `name:`。改 job 名就要同步改這裡，否則 GitHub 會等一個永不出現的 check ＝永遠卡住合併。 |
| required check 的來源（`app_id`） | **null（未綁定）** | ⚠️ 誠實劃界（Codex r1）：未綁 GitHub App 時，**任何有 write 權限的人或整合都能蓋一個同名的綠色 status**；且 workflow 跑的是 PR 自帶版本＝**PR 可以改掉閘自己**。三方共用同一個 write token，所以這道閘擋得住**手滑**（忘了填欄位、貼錯基準），擋不住**蓄意**——與 reviews 那格同一句誠實話：守它的是規矩，不是鎖。 |
| strict（要求分支為最新） | 開 | 過期分支的綠燈不算數。 |
| **enforce_admins** | **開** | ⚠️ 最重要的一格。單一身分（Claude／Codex／Grok 都用 teacherjung 的 token）之下，**逃生門與強制力是同一個開關**——不開等於沒保護。理財 webapp 2026-08-02 的教訓。 |
| allow_force_pushes | 關 | |
| allow_deletions | 關 | |
| required_pull_request_reviews | null（不啟用） | GitHub 的 review 機制需要第二個 GitHub 帳號才有意義；本專案三方共用同一身分，分工靠**協作欄位閘**把關，不靠 GitHub reviews。這是誠實劃界：**這裡沒有鎖在守「誰按合併鍵」，靠的是規矩。** |

## 驗證紀錄

- 2026-09-02：直推 main 實測 → 被拒。閘會叫。實際輸出：
  ```
  remote: error: GH006: Protected branch update failed for refs/heads/main.
   ! [remote rejected] claude/branch-protection-doc -> main (protected branch hook declined)
  ```
  （2026-09-01 首測同結果；當時寫「見下方輸出」卻沒貼——引用要兌現，Codex r1 Low 抓到。）
- 2026-09-01：協作欄位閘離線探針 `experiments/gate-probe.mjs` → 五案例四擋一放行。

## 重設方式

```bash
gh api -X PUT repos/teacherjung/guided-notes-generator/branches/main/protection \
  -H "Accept: application/vnd.github+json" --input <設定 JSON>
```
